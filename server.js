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
    const { tests, parentKey } = req.body;

    const projectKey = parentKey.split("-")[0];

    for (const test of tests) {
      await axios.post(
        `${process.env.JIRA_BASE}/rest/api/3/issue`,
        {
          fields: {
            project: { key: projectKey },
            summary: test.name,
            description: test.objective,
            issuetype: { name: "Test" },
            priority: { name: test.priority || "Medium" }
          }
        },
        {
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/json"
          }
        }
      );
    }

    res.json({ message: "Tests created successfully" });

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: "Failed to create tests" });
  }
});

app.listen(3001, () => console.log("Server running on port 3001"));