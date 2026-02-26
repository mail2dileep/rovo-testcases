require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const auth = Buffer.from(
  `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
).toString("base64");

app.post("/create-tests", async (req, res) => {
  try {
    console.log("🔥 Webhook triggered");
    console.log("Incoming body:", req.body);

    let { tests, parentKey } = req.body;

    if (!tests) {
      console.log("❌ No tests received");
      return res.status(400).json({ error: "No tests received" });
    }

    // Handle both string and array cases
    let parsedTests;

    if (typeof tests === "string") {
      if (tests.trim() === "") {
        console.log("❌ Tests string empty");
        return res.status(400).json({ error: "Tests empty string" });
      }
      parsedTests = JSON.parse(tests);
    } else if (Array.isArray(tests)) {
      parsedTests = tests;
    } else {
      console.log("❌ Unexpected tests format:", typeof tests);
      return res.status(400).json({ error: "Invalid tests format" });
    }

    console.log("Parsed tests:", parsedTests);

    if (!Array.isArray(parsedTests) || parsedTests.length === 0) {
      console.log("❌ Parsed tests is empty array");
      return res.status(400).json({ error: "No test cases found" });
    }

    // Derive project from first test's requirementId
    const parentKeyFromTest = parsedTests[0].requirementId;
    const projectKey = parentKeyFromTest.split("-")[0];

    console.log("Project key:", projectKey);

    for (const test of parsedTests) {
      console.log("Creating test:", test.name);

      const issueResponse = await axios.post(
        `${process.env.JIRA_BASE}/rest/api/3/issue`,
        {
          fields: {
            project: { key: projectKey },
            summary: test.name,
            description: test.objective,
            issuetype: { name: "Test" }
          }
        },
        {
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/json"
          }
        }
      );

      console.log("✅ Created:", issueResponse.data.key);
    }

    res.json({ message: "Tests created successfully" });

  } catch (error) {
    console.error("🔥 REAL ERROR:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data || error.message
    });
  }
});

app.listen(3001, () => console.log("Server running on port 3001"));