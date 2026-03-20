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
   UTIL
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
  return response.data.id;
}

/* =====================================================
   DUPLICATE CHECK
===================================================== */

async function checkDuplicateTest(projectKey, testName) {

  const safeName = escapeJQL(testName);

  const jql = `project = ${projectKey} AND issuetype = "Test" AND summary = "${safeName}"`;

  console.log("🔍 Checking for duplicate with JQL:", jql);

  const response = await axios.post(
    `${JIRA_BASE}/rest/api/3/search/jql`,
    {
      jql: jql,
      maxResults: 1,
      fields: ["summary", "key", "issuetype"]
    },
    { headers: jiraHeaders }
  );

  console.log("Duplicate raw response:", JSON.stringify(response.data, null, 2));

  const issues = response.data.issues || [];

  console.log("Duplicate search count:", issues.length);
  
  if (issues.length > 0) {
    console.log("Found duplicate:", issues[0].key, "-", issues[0].fields?.summary);
  }

  return issues.length > 0;
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
   GENERATE ZEPHYR JWT (CANONICAL SAFE)
===================================================== */

function generateZephyrJWT(method, path, queryParams) {
  const epoch = Math.floor(Date.now() / 1000);
  const expiry = epoch + 60;

  const sortedKeys = Object.keys(queryParams).sort();

  const canonicalQuery = sortedKeys
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key])}`)
    .join("&");

  const canonical = `${method.toUpperCase()}&${path}&${canonicalQuery}`;

  const qsh = crypto
    .createHash("sha256")
    .update(canonical)
    .digest("hex");

  console.log("\n===== CONNECT DEBUG =====");
  console.log("Canonical:", canonical);
  console.log("QSH:", qsh);
  console.log("=========================\n");

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
   ADD ZEPHYR STEPS (NUMERIC ISSUE ID)
===================================================== */

async function addTestSteps(issueId, projectId, steps) {

  const requestPath = `/connect/public/rest/api/1.0/teststep/${issueId}`;
  const canonicalPath = `/public/rest/api/1.0/teststep/${issueId}`;

  console.log(`Adding ${steps.length} test steps to issue ${issueId}...`);

  for (const s of steps) {

    const queryParams = {
      projectId: String(projectId)
    };

    const token = generateZephyrJWT("POST", canonicalPath, queryParams);

    try {
      console.log(`Adding step: ${s.step}`);
      
      const response = await axios.post(
        `${ZEPHYR_BASE}${requestPath}`,
        {
          step: s.step,
          data: s.data || "",
          result: s.result || ""
        },
        {
          params: queryParams,
          headers: {
            Authorization: `JWT ${token}`,
            zapiAccessKey: process.env.ZEPHYR_ACCESS_KEY,
            "Content-Type": "application/json"
          }
        }
      );
      
      console.log(`✓ Step added successfully. Response:`, response.data);
    } catch (error) {
      console.error(`✗ Failed to add step: ${s.step}`, error.response?.data || error.message);
      throw error;
    }
  }
}
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
    result: index === stepsArray.length - 1
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
    let duplicates = 0;

    for (const test of parsedTests) {

      if (!test.requirementId || !test.name) {
        skipped++;
        continue;
      }

      const storyKey = test.requirementId;
      const projectKey = storyKey.split("-")[0];

      console.log(`Processing: ${test.name}`);

      const projectId = await getProjectId(projectKey);

      const isDuplicate = await checkDuplicateTest(projectKey, test.name);

      if (isDuplicate) {
        console.log("Duplicate found. Skipping...");
        duplicates++;
        continue;
      }

      const issueResponse = await axios.post(
        `${JIRA_BASE}/rest/api/3/issue`,
        {
          fields: {
            project: { key: projectKey },
            summary: test.name,
            issuetype: { name: "Test" },
            labels: [`AUTO_${storyKey}`],
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

      let formattedSteps = [];

      if (Array.isArray(test.steps)) {
        formattedSteps = test.steps;
      } else if (typeof test.steps === "string") {
        formattedSteps = parseNumberedSteps(
          test.steps,
          test.expectedresult
        );
      }

      console.log(`Test "${test.name}" created with key: ${createdTestKey}, ID: ${createdTestId}`);
      console.log(`Steps to add: ${formattedSteps.length}`);

      if (formattedSteps.length > 0) {
        try {
          await addTestSteps(createdTestId, projectId, formattedSteps);
          console.log(`✓ All test steps added successfully`);
        } catch (error) {
          console.error(`✗ Failed to add test steps:`, error.message);
          throw error;
        }
      } else {
        console.warn(`⚠ No test steps found to add`);
      }

      await linkToStory(createdTestKey, storyKey);
      console.log(`✓ Test linked to story: ${storyKey}`);

      created++;
    }

    res.json({ message: "Completed", created, skipped, duplicates });

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