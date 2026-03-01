require("dotenv").config();
const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const app = express();
app.use(express.json());

/* =====================================================
   CONFIG
===================================================== */

const JIRA_BASE = process.env.JIRA_BASE;
const ZEPHYR_BASE = "https://prod-api.zephyr4jiracloud.com";

const jiraAuth = Buffer.from(
  `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
).toString("base64");

const jiraHeaders = {
  Authorization: `Basic ${jiraAuth}`,
  "Content-Type": "application/json",
  Accept: "application/json"
};

/* =====================================================
   ESCAPE JQL
===================================================== */

function escapeJQL(text = "") {
  return text.replace(/["\\]/g, "\\$&");
}

/* =====================================================
   GET PROJECT ID
===================================================== */

async function getProjectId(projectKey) {
  const response = await axios.get(
    `${JIRA_BASE}/rest/api/3/project/${projectKey}`,
    { headers: jiraHeaders }
  );

  const projectId = response.data.id;

  console.log("📌 Project Key:", projectKey);
  console.log("📌 Project ID:", projectId);

  return projectId;
}

/* =====================================================
   DUPLICATE CHECK
===================================================== */

async function checkDuplicateTest(projectKey, storyKey, testName) {
  const safeName = escapeJQL(testName);

  const jql = `project = ${projectKey} AND issuetype = Test AND summary = "${safeName}" AND issue in linkedIssues("${storyKey}")`;

  const response = await axios.post(
    `${JIRA_BASE}/rest/api/3/search/jql`,
    { jql, maxResults: 1 },
    { headers: jiraHeaders }
  );

  return response.data.total > 0;
}

/* =====================================================
   LINK TEST TO STORY
===================================================== */

async function linkToStory(testKey, storyKey) {
  await axios.post(
    `${JIRA_BASE}/rest/api/3/issueLink`,
    {
      type: { name: "Relates" },
      inwardIssue: { key: storyKey },
      outwardIssue: { key: testKey }
    },
    { headers: jiraHeaders }
  );
}

/* =====================================================
   GENERATE ZEPHYR JWT (WITH DEBUG LOGS)
===================================================== */

function generateZephyrJWT(method, fullUrl) {
  const epoch = Math.floor(Date.now() / 1000);
  const expiry = epoch + 60;

  const url = new URL(fullUrl);

  const pathname = url.pathname.replace(/\/+$/, "");

  const params = Array.from(url.searchParams.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) =>
      `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    )
    .join("&");

  const canonical = `${method.toUpperCase()}&${pathname}&${params}`;

  const qsh = crypto
    .createHash("sha256")
    .update(canonical)
    .digest("hex");

  console.log("\n===== DEBUG =====");
  console.log("Canonical:", canonical);
  console.log("QSH:", qsh);
  console.log("=================\n");

  return jwt.sign(
    {
      iss: process.env.ZEPHYR_ACCESS_KEY,
      iat: epoch,
      exp: expiry,
      qsh
    },
    process.env.ZEPHYR_SECRET_KEY,
    { algorithm: "HS256" }
  );
}
/* =====================================================
   ADD ZEPHYR STEPS (USES NUMERIC ISSUE ID)
===================================================== */
async function addTestSteps(issueId, projectId, steps) {
  const url = `${ZEPHYR_BASE}/connect/public/rest/api/1.0/teststep/${issueId}?projectId=${projectId}`;

  for (const s of steps) {

    const token = generateZephyrJWT("POST", url);
    console.log("Token value:", token);

    await axios.post(
      url,
      {
        step: s.step,
        data: s.data || "",
        result: s.result || ""
      },
      {
        headers: {
          Authorization: `JWT ${token}`,
          zapiAccessKey: process.env.ZEPHYR_ACCESS_KEY,
          "Content-Type": "application/json"
        }
      }
    );
  }
}  // ✅ THIS WAS MISSING
/* =====================================================
   PARSE NUMBERED STEPS
===================================================== */

function parseNumberedSteps(stepsString, expectedResult) {
  if (!stepsString || typeof stepsString !== "string") return [];

  const stepsArray = stepsString
    .split("\n")
    .map(step => step.trim())
    .filter(Boolean)
    .map(step => step.replace(/^\d+\.\s*/, ""));

  return stepsArray.map((stepText, index) => ({
    step: stepText,
    data: "",
    result:
      index === stepsArray.length - 1
        ? expectedResult || ""
        : ""
  }));
}

/* =====================================================
   MAIN ENDPOINT
===================================================== */

app.post("/create-tests", async (req, res) => {
  try {
    console.log("🔥 Webhook triggered");

    const { tests } = req.body;
    if (!tests) return res.status(400).json({ error: "No tests received" });

    const parsedTests =
      typeof tests === "string" ? JSON.parse(tests) : tests;

    let created = 0;
    let skipped = 0;

    for (const test of parsedTests) {
      if (!test.requirementId || !test.name) {
        skipped++;
        continue;
      }

      const storyKey = test.requirementId;
      const projectKey = storyKey.split("-")[0];

      console.log(`\nProcessing: ${test.name}`);

      const projectId = await getProjectId(projectKey);
      console.log(`Using Project ID ${projectId}`);

      const isDuplicate = await checkDuplicateTest(
        projectKey,
        storyKey,
        test.name
      );

      if (isDuplicate) {
        console.log("Duplicate found. Skipping...");
        skipped++;
        continue;
      }

      /* -------- Create Jira Test -------- */
      const issueResponse = await axios.post(
        `${JIRA_BASE}/rest/api/3/issue`,
        {
          fields: {
            project: { key: projectKey },
            summary: test.name,
            issuetype: { name: "Test" },
            description: {
              type: "doc",
              version: 1,
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: test.objective || "" }
                  ]
                }
              ]
            }
          }
        },
        { headers: jiraHeaders }
      );

      const createdTestKey = issueResponse.data.key;
      const createdTestId = issueResponse.data.id; // NUMERIC

      console.log("Created:", createdTestKey);
      console.log("Numeric Issue ID:", createdTestId);

      /* -------- Prepare Steps -------- */
      let formattedSteps = [];

      if (Array.isArray(test.steps)) {
        formattedSteps = test.steps;
      } else if (typeof test.steps === "string") {
        formattedSteps = parseNumberedSteps(
          test.steps,
          test.expectedresult
        );
      }

      if (formattedSteps.length > 0) {
        await addTestSteps(createdTestId, projectId, formattedSteps);
        console.log("Steps added");
      }

      await linkToStory(createdTestKey, storyKey);
      console.log("Linked to story");

      created++;
    }

    res.json({ message: "Completed", created, skipped });

  } catch (error) {
    console.error("🔥 ERROR:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data || error.message
    });
  }
});

/* =====================================================
   START SERVER
===================================================== */

app.listen(3001, () =>
  console.log("🚀 Server running on port 3001")
);