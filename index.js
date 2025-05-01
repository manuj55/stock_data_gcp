const express = require('express');
const fileUpload = require('express-fileupload');
const { Storage } = require('@google-cloud/storage');
const { Pool } = require('pg');
const { from: copyFrom } = require('pg-copy-streams');
const csv = require('csv-parser');
const { PassThrough } = require('stream');

const app = express();
app.set('view engine', 'ejs');
app.use(fileUpload());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Configure GCS
const storage = new Storage({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
const BUCKET_NAME = `dump_advance_data_science`;

// Configure Postgres pool: always pass an object
let pool;
if (process.env.INSTANCE_CONNECTION_NAME) {
    pool = new Pool({
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        host: `/cloudsql/${process.env.INSTANCE_CONNECTION_NAME}`,
        // no port: socket only
    });
} else if (process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
}


async function ensureTables() {
    const client = await pool.connect();
    try {
        await client.query(`
        CREATE TABLE IF NOT EXISTS companies (
          id          INTEGER PRIMARY KEY,
          name        TEXT,
          stock_price NUMERIC(10,2),
          high_price  NUMERIC(10,2),
          low_price   NUMERIC(10,2)
        );
      `);
        await client.query(`
        CREATE TABLE IF NOT EXISTS transactions (
          id               INTEGER PRIMARY KEY,
          company_id       INTEGER REFERENCES companies(id),
          buy_price        NUMERIC(10,2),
          sell_price       NUMERIC(10,2),
          transaction_date DATE
        );
      `);
        await client.query(`
        CREATE TABLE IF NOT EXISTS historical_data (
          id          INTEGER PRIMARY KEY,
          company_id  INTEGER REFERENCES companies(id),
          date        DATE,
          open_price  NUMERIC(10,2),
          close_price NUMERIC(10,2),
          volume      BIGINT
        );
      `);
    } finally {
        client.release();
    }
}


async function uploadHandler(req, res) {
    try {
        const files = req.files || {};
        if (!files.companies || !files.transactions || !files.historical) {
            throw new Error('Please upload all three CSVs: companies, transactions, historical');
        }


        await pool.query(
            'TRUNCATE companies, transactions, historical_data RESTART IDENTITY CASCADE'
        );


        const bucket = storage.bucket(BUCKET_NAME);
        const [exists] = await bucket.exists();
        if (!exists) {
            await bucket.create();
        }

        await Promise.all(Object.values(files).map(file =>
            bucket.file(file.name).save(file.data, { resumable: false })
        ));

        const streamCsv = async (buffer, table, columns) => {
            const client = await pool.connect();
            try {
                const sql = `COPY ${table}(${columns.join(',')}) FROM STDIN WITH (FORMAT CSV, HEADER TRUE)`;
                const copyStream = client.query(copyFrom(sql));
                const pass = new PassThrough();
                pass.end(buffer);
                await new Promise((resolve, reject) => {
                    pass.pipe(copyStream)
                        .on('finish', resolve)
                        .on('error', reject);
                });
            } finally {
                client.release();
            }
        };

        await streamCsv(files.companies.data, 'companies', ['id', 'name', 'stock_price', 'high_price', 'low_price']);
        await streamCsv(files.transactions.data, 'transactions', ['id', 'company_id', 'buy_price', 'sell_price', 'transaction_date']);
        await streamCsv(files.historical.data, 'historical_data', ['id', 'company_id', 'date', 'open_price', 'close_price', 'volume']);

        res.send('⬆️ CSVs uploaded to GCS and imported into Postgres!');
    } catch (err) {
        console.error('Upload/import error:', err);
        res.status(500).send('Error: ' + err.message);
    }
}

async function searchHandler(req, res) {
    const q = req.body.query;
    try {
        const { rows } = await pool.query(
            'SELECT * FROM companies WHERE name ILIKE $1',
            [`%${q}%`]
        );
        res.render('search', { results: rows });
    } catch (err) {
        console.error('Search error:', err);
        res.status(500).send(err.message);
    }
}


async function main() {
    await ensureTables();

    app.get('/', (req, res) => res.render('upload'));
    app.post('/upload', uploadHandler);
    app.get('/search', (req, res) => res.render('search', { results: [] }));
    app.post('/search', searchHandler);

    const PORT = process.env.PORT || 8080;
    app.listen(PORT, () => console.log(`Server on port ${PORT}`));
}

main().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});