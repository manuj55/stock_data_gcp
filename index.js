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
pool = new Pool({ connectionString: process.env.DATABASE_URL });


// Ensure tables exist on startup
(async () => {
    const client = await pool.connect();
    try {
        await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id          INTEGER PRIMARY KEY,
        name        TEXT,
        stock_price NUMERIC(10,2),
        high_price  NUMERIC(10,2),
        low_price   NUMERIC(10,2)
      )
    `);
        await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id               INTEGER PRIMARY KEY,
        company_id       INTEGER REFERENCES companies(id),
        buy_price        NUMERIC(10,2),
        sell_price       NUMERIC(10,2),
        transaction_date DATE
      )
    `);
        await client.query(`
      CREATE TABLE IF NOT EXISTS historical_data (
        id          INTEGER PRIMARY KEY,
        company_id  INTEGER REFERENCES companies(id),
        date        DATE,
        open_price  NUMERIC(10,2),
        close_price NUMERIC(10,2),
        volume      BIGINT
      )
    `);
    } catch (err) {
        console.error('Error creating tables:', err);
    } finally {
        client.release();
    }
})();

// Home route - upload form
app.get('/', (req, res) => res.render('upload'));

// Upload & import handler
app.post('/upload', async (req, res) => {
    try {
        const files = req.files || {};
        ['companies', 'transactions', 'historical'].forEach(key => {
            if (!files[key]) throw new Error(`${key} CSV missing`);
        });

        // Ensure bucket exists
        const bucket = storage.bucket(BUCKET_NAME);
        const [exists] = await bucket.exists();
        if (!exists) await bucket.create();

        // Upload to GCS
        await Promise.all(
            Object.values(files).map(file =>
                bucket.file(file.name).save(file.data, { resumable: false })
            )
        );

        // Helper to COPY CSV into Postgres
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

        // Stream each CSV into its table
        await streamCsv(files.companies.data, 'companies', [
            'id', 'name', 'stock_price', 'high_price', 'low_price'
        ]);
        await streamCsv(files.transactions.data, 'transactions', [
            'id', 'company_id', 'buy_price', 'sell_price', 'transaction_date'
        ]);
        await streamCsv(files.historical.data, 'historical_data', [
            'id', 'company_id', 'date', 'open_price', 'close_price', 'volume'
        ]);

        res.send('CSV files uploaded to GCS and imported successfully.');
    } catch (err) {
        console.error('Upload/import error:', err);
        res.status(500).send('Error: ' + err.message);
    }
});

// Search route - form
app.get('/search', (req, res) => res.render('search', { results: [] }));

// Search handler
app.post('/search', async (req, res) => {
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
});

// Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));