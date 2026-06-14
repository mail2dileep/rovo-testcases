# Jira Test Creation API

A Node.js Express server that automatically creates Jira test cases with Zephyr integration. This API processes test data and creates corresponding test issues in Jira, links them to user stories, and adds test steps using Zephyr.

## Features

- ✅ **Duplicate Detection**: Prevents creation of duplicate test cases
- 🔗 **Story Linking**: Automatically links tests to their corresponding user stories
- 📝 **Test Steps**: Adds detailed test steps using Zephyr integration
- 🏷️ **Auto-labeling**: Tags tests with story references for easy tracking
- 📊 **Statistics**: Returns creation, skipped, and duplicate counts

## Prerequisites

- Node.js (v14 or higher)
- Jira Cloud instance with API access
- Zephyr for Jira Cloud integration
- API credentials for both Jira and Zephyr

## Installation

1. Clone or download the project files
2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory with the following variables:
   ```env
   JIRA_BASE=https://your-jira-instance.atlassian.net
   JIRA_EMAIL=your-email@company.com
   JIRA_API_TOKEN=your-jira-api-token
   ZEPHYR_ACCESS_KEY=your-zephyr-access-key
   ZEPHYR_SECRET_KEY=your-zephyr-secret-key
   ```

## Configuration

### Jira Setup
1. Generate an API token from your Jira account settings
2. Ensure your user has permissions to create issues and link them

### Zephyr Setup
1. Install Zephyr for Jira Cloud
2. Generate access keys from Zephyr settings
3. Ensure test issue types are configured in your Jira project

## API Usage

### POST /create-tests

Creates test cases in Jira based on the provided test data.

**Request Body:**
```json
{
  "tests": [
    {
      "requirementId": "PROJ-123",
      "name": "Test case title",
      "objective": "Test objective description",
      "steps": [
        {
          "step": "Step description",
          "data": "Test data",
          "result": "Expected result"
        }
      ],
      "expectedresult": "Overall expected result"
    }
  ]
}
```

**Alternative Steps Format:**
```json
{
  "tests": [
    {
      "requirementId": "PROJ-123",
      "name": "Test case title",
      "steps": "1. First step\n2. Second step\n3. Third step",
      "expectedresult": "Overall expected result"
    }
  ]
}
```

**Response:**
```json
{
  "message": "Completed",
  "created": 5,
  "skipped": 1,
  "duplicates": 2
}
```

## How It Works

1. **Validation**: Checks for required fields (`requirementId`, `name`)
2. **Duplicate Check**: Searches for existing tests with the same title in the project
3. **Test Creation**: Creates a new Jira issue with type "Test"
4. **Labeling**: Adds an `AUTO_{storyKey}` label for tracking
5. **Step Addition**: Adds test steps using Zephyr API
6. **Linking**: Creates a "Relates" link between the test and the story

## Project Structure

```
├── server.js          # Main application file
├── package.json       # Dependencies and scripts
├── .env              # Environment variables (create this)
└── README.md         # This file
```

## Dependencies

- `express`: Web framework
- `axios`: HTTP client for API calls
- `jsonwebtoken`: JWT token generation for Zephyr
- `crypto`: Hash generation for Zephyr authentication
- `dotenv`: Environment variable management
- `moment`: Date/time utilities

## Running the Server

```bash
node server.js
```

The server will start on port 3001. You can test it with:

```bash
curl -X POST http://localhost:3001/create-tests \
  -H "Content-Type: application/json" \
  -d @test-data.json
```

## Error Handling

The API includes comprehensive error handling:
- Invalid request data
- Jira API authentication failures
- Zephyr integration errors
- Duplicate detection issues

All errors are logged to the console and returned in the response.

## Security Notes

- Store API tokens securely in environment variables
- Never commit `.env` files to version control
- Use HTTPS in production
- Implement proper authentication/authorization for the endpoint

## Troubleshooting

### Common Issues

1. **"The requested API has been removed"**: Update to the latest Jira API endpoints
2. **Duplicate tests still being created**: Check JQL query and issue type names
3. **Zephyr steps not adding**: Verify Zephyr credentials and project configuration

### Debug Mode

Enable detailed logging by checking the console output. The application logs:
- JQL queries for duplicate checking
- API responses
- Step addition progress
- Error details

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the ISC License.