require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

/* =====================================================
   CONFIG
===================================================== */

const JIRA_BASE = process.env.JIRA_BASE; // https://credera.atlassian.net
const auth = Buffer.from(
  `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
).toString("base64");

const headers = {
  Authorization: `Basic ${auth}`,
  "Content-Type": "application/json"
};

/* =====================================================
   HELPER: Escape JQL String (Prevents JQL break)
===================================================== */

function escapeJQL(text) {
  return text.replace(/"/g, '\\"');
}

/* =====================================================
   HELPER: Check Duplicate Test (Exact match under story)
===================================================== */

async function checkDuplicateTest(projectKey, storyKey, testName) {
  const safeName = escapeJQL(testName);

  const jql = `
    project = ${projectKey}
    AND issuetype = Test
    AND summary = "${safeName}"
    AND issue in linkedIssues("${storyKey}")
  `;

  const response = await axios.get(
    `${JIRA_BASE}/rest/api/3/search`,
    {
      headers,
      params: { jql, maxResults: 1 }
    }
  );

  return response.data.total > 0;
}

/* =====================================================
   HELPER: Link Test to Story (Relates)
===================================================== */

async function linkToStory(testKey, storyKey) {
  await axios.post(
    `${JIRA_BASE}/rest/api/3/issueLink`,
    {
      type: { name: "Relates" },
      inwardIssue: { key: storyKey },
      outwardIssue: { key: testKey }
    },
    { headers }
  );
}

/* =====================================================
   HELPER: Add Zephyr Test Steps
===================================================== */

async function addTestSteps(issueId, steps) {
  for (const s of steps) {
    await axios.post(
      `${JIRA_BASE}/rest/zapi/latest/teststep/${issueId}`,
      {
        step: s.step,
        data: s.data || "",
        result: s.result || ""
      },
      { headers }
    );
  }
}

/* =====================================================
   HELPER: Parse Numbered Steps (Fallback Support)
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

    let { tests } = req.body;

    if (!tests) {
      return res.status(400).json({ error: "No tests received" });
    }

    const parsedTests =
      typeof tests === "string" ? JSON.parse(tests) : tests;

    if (!Array.isArray(parsedTests) || parsedTests.length === 0) {
      return res.status(400).json({ error: "No test cases found" });
    }

    let created = 0;
    let skipped = 0;

    for (const test of parsedTests) {
      if (!test.requirementId) {
        console.log("⚠️ Missing requirementId. Skipping test.");
        skipped++;
        continue;
      }

      const storyKey = test.requirementId;
      const projectKey = storyKey.split("-")[0];

      console.log(`\nProcessing: ${test.name}`);

      /* ---------- Duplicate Check ---------- */
      const isDuplicate = await checkDuplicateTest(
        projectKey,
        storyKey,
        test.name
      );

      if (isDuplicate) {
        console.log("⚠️ Duplicate found. Skipping...");
        skipped++;
        continue;
      }

      /* ---------- Create Jira Test Issue ---------- */
      const issueResponse = await axios.post(
        `${JIRA_BASE}/rest/api/3/issue`,
        {
          fields: {
            project: { key: projectKey },
            summary: test.name,
            issuetype: { name: "Test" },
            priority: test.priority
              ? { name: test.priority }
              : undefined,
            description: {
              type: "doc",
              version: 1,
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: test.objective || ""
                    }
                  ]
                }
              ]
            }
          }
        },
        { headers }
      );

      const createdTestKey = issueResponse.data.key;
      const createdTestId = issueResponse.data.id;

      console.log("✅ Created:", createdTestKey);

      /* ---------- Prepare Steps ---------- */
      let formattedSteps = [];

      if (Array.isArray(test.steps)) {
        formattedSteps = test.steps;
      } else if (typeof test.steps === "string") {
        formattedSteps = parseNumberedSteps(
          test.steps,
          test.expectedresult
        );
      }

      /* ---------- Add Zephyr Steps ---------- */
      if (formattedSteps.length > 0) {
        await addTestSteps(createdTestId, formattedSteps);
        console.log("✅ Steps added");
      } else {
        console.log("⚠️ No valid steps found");
      }

      /* ---------- Link Test to Story ---------- */
      await linkToStory(createdTestKey, storyKey);
      console.log("🔗 Linked to story:", storyKey);

      created++;
    }

    res.json({
      message: "Execution completed",
      created,
      skipped
    });

  } catch (error) {
    console.error("🔥 REAL ERROR:", error.response?.data || error.message);
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