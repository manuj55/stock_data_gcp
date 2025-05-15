# GCP CSV Upload and Company Management

## Description
This Node.js application allows you to:
- Upload CSV files for Companies, Transactions, and Historical Data
- Import CSV data into a PostgreSQL database via COPY commands
- Manage companies with update and delete operations
- Search for companies and display associated transactions and historical data using Google Charts

## Prerequisites
- Node.js 14+ installed
- PostgreSQL database instance
- Google Cloud project with Cloud Storage and Cloud SQL configured
- Environment variables set either in a `.env` file or through your deployment environment. Refer to [app.yaml](app.yaml) for configuration details.

## Setup Instructions
1. **Clone the repository**
2. **Install dependencies**
   ````bash
   npm install