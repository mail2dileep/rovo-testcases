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

const JIRA_BASE = process.env.JIRA_BASE; // https://credera.atlassian.net
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
   HELPER: Escape JQL
===================================================== */

function escapeJQL(text = "") {
  return text.replace(/["\\]/g, "\\$&");
}

/* =====================================================
   HELPER: Duplicate Check (Jira Cloud)
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
   HELPER: Link Test to Story
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
   HELPER: Generate Zephyr JWT
===================================================== */

function generateZephyrJWT(method, apiPath) {
  const epoch = Math.floor(Date.now() / 1000);
  const expiry = epoch + 60;

  const canonical = `${method}&${apiPath}&`;

  const qsh = crypto
    .createHash("sha256")
    .update(canonical)
    .digest("hex");

  return jwt.sign(
    {
      iss: process.env.ZEPHYR_ACCESS_KEY,
      iat: epoch,
      exp: expiry,
      qsh
    },
    process.env.ZEPHYR_SECRET_KEY
  );
}

/* =====================================================
   HELPER: Add Zephyr Steps (Cloud)
===================================================== */

async function addTestSteps(issueId, steps) {
  const apiPath = `/connect/public/rest/api/1.0/teststep/${issueId}`;
  const url = `${ZEPHYR_BASE}${apiPath}`;
  const token = generateZephyrJWT("POST", apiPath);

  for (const s of steps) {
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
}

/* =====================================================
   HELPER: Parse Numbered Steps (Fallback)
===================================================== */

function parseNumberedSteps(stepsString, expectedResult) {
  if (!stepsString || typeof stepsString !== "string") return [];

  const stepsArray = stepsString
    .split("\n")
    .map(step => step.trim())
    .filter(step => step.length > 0)
    .map(step => step.replace(/^\d+\.\s*/, ""));

  return stepsArray.map((stepText, index) => ({
    step: stepText,
    data: "",
    result: index === stepsArray.length - 1 ? expectedResult || "" : ""
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

      console.log(`Processing: ${test.name}`);

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
      const createdTestId = issueResponse.data.id;

      console.log("Created:", createdTestKey);

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
        await addTestSteps(createdTestId, formattedSteps);
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