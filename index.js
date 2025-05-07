const express = require('express');
const fileUpload = require('express-fileupload');
const { Storage } = require('@google-cloud/storage');
const { Pool } = require('pg');
const { from: copyFrom } = require('pg-copy-streams');
const { PassThrough } = require('stream');

const app = express();
app.set('view engine', 'ejs');
app.use(fileUpload());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const BUCKET_NAME = 'dump_advance_data_science';
const storage = new Storage({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
let pool;
if (process.env.INSTANCE_CONNECTION_NAME) {
    pool = new Pool({
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        host: `/cloudsql/${process.env.INSTANCE_CONNECTION_NAME}`
    });
} else if (process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
}


async function ensureTables() {
    const client = await pool.connect();
    try {
        await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id                   INTEGER PRIMARY KEY,
        company_name         TEXT,
        current_price        NUMERIC(14,2),
        sector               TEXT,
        country              TEXT,
        founding_year        INTEGER,
        shares_outstanding   BIGINT,
        market_cap           NUMERIC(20,2)
      );
    `);
        await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id                INTEGER PRIMARY KEY,
        company_id        INTEGER,
        transaction_date  DATE,
        buy_price         NUMERIC(14,2),
        sell_price        NUMERIC(14,2),
        quantity          INTEGER,
        transaction_type  TEXT,
        trader_id         INTEGER,
        commission_fee    NUMERIC(14,2),
        currency          TEXT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
      );
    `);
        await client.query(`
      CREATE TABLE IF NOT EXISTS historical_data (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER,
        date         DATE,
        open_price   NUMERIC(14,2),
        close_price  NUMERIC(14,2),
        high_price   NUMERIC(14,2),
        low_price    NUMERIC(14,2),
        volume       BIGINT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
      );
    `);
    } finally {
        client.release();
    }
}

async function uploadHandler(req, res) {
    const start = Date.now();
    try {
        const files = req.files || {};
        if (!files.companies || !files.transactions || !files.historical) {
            throw new Error('Please upload all three CSVs.');
        }
        await pool.query('TRUNCATE companies, transactions, historical_data RESTART IDENTITY CASCADE');
        const bucket = storage.bucket(BUCKET_NAME);
        const [exists] = await bucket.exists();
        if (!exists) await bucket.create();
        const uploadStart = Date.now();
        await Promise.all(Object.values(files).map(f => bucket.file(f.name).save(f.data, { resumable: false })));
        const uploadDuration = Date.now() - uploadStart;
        console.log(`File upload to GCS bucket took: ${uploadDuration}ms`);
        const streamCsv = async (buffer, table, cols) => {
            const client = await pool.connect();
            try {
                const sql = `COPY ${table}(${cols.join(',')}) FROM STDIN WITH (FORMAT CSV, HEADER TRUE)`;
                const pgStream = client.query(copyFrom(sql));
                const pass = new PassThrough();
                pass.end(buffer);
                await new Promise((ok, ko) => pass.pipe(pgStream).on('finish', ok).on('error', ko));
            } finally {
                client.release();
            }
        };
        const exportStartSQL = Date.now();
        await streamCsv(files.companies.data, 'companies', ['id', 'company_name', 'current_price', 'sector', 'country', 'founding_year', 'shares_outstanding', 'market_cap']);
        await streamCsv(files.transactions.data, 'transactions', ['id', 'company_id', 'transaction_date', 'buy_price', 'sell_price', 'quantity', 'transaction_type', 'trader_id', 'commission_fee', 'currency']);
        await streamCsv(files.historical.data, 'historical_data', ['company_id', 'date', 'open_price', 'close_price', 'high_price', 'low_price', 'volume']);
        const exportDurationSQL = Date.now() - exportStartSQL;
        console.log(`File export to  sql took: ${exportDurationSQL}ms`);
        res.redirect(`/?uploadDuration=${uploadDuration}&elapsedUpload=${exportDurationSQL}`);
    } catch (err) {
        console.error('Upload/import error:', err);
        res.status(500).send('Error: ' + err.message);
    }
}

async function deleteHandler(req, res) {
    try {
        const { filename } = req.body;
        if (!filename) throw new Error('No filename provided');
        await storage.bucket(BUCKET_NAME).file(filename).delete();
        res.redirect('/');
    } catch (err) {
        console.error('Delete error:', err);
        res.status(500).send('Error deleting file: ' + err.message);
    }
}

async function deleteCompanyHandler(req, res) {
    const start = Date.now();
    try {
        const { id } = req.body;
        await pool.query('BEGIN');
        await pool.query('DELETE FROM companies WHERE id = $1', [id]);
        await pool.query('COMMIT');
        const duration = Date.now() - start;
        res.redirect(`/search?elapsedDelete=${duration}`);
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('Delete company error:', err);
        res.status(500).send('Error deleting company: ' + err.message);
    }
}

async function updateCompanyHandler(req, res) {
    const start = Date.now();
    try {
        const { id, company_name, current_price, sector, country, founding_year, shares_outstanding, market_cap } = req.body;
        await pool.query('BEGIN');
        await pool.query(
            `UPDATE companies SET company_name=$1, current_price=$2, sector=$3, country=$4, founding_year=$5, shares_outstanding=$6, market_cap=$7 WHERE id=$8`,
            [company_name, current_price, sector, country, founding_year, shares_outstanding, market_cap, id]
        );
        await pool.query('COMMIT');
        const duration = Date.now() - start;
        res.redirect(`/search?elapsedUpdate=${duration}`);
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('Update company error:', err);
        res.status(500).send('Error updating company: ' + err.message);
    }
}

async function searchHandler(req, res) {
    const start = Date.now();
    const q = req.body.query || '';
    try {
        const { rows: companies } = await pool.query('SELECT * FROM companies WHERE company_name ILIKE $1', [`%${q}%`]);
        for (let c of companies) {
            const txRes = await pool.query('SELECT * FROM transactions WHERE company_id = $1 ORDER BY transaction_date', [c.id]);
            const histRes = await pool.query('SELECT * FROM historical_data WHERE company_id = $1 ORDER BY date', [c.id]);
            c.transactions = txRes.rows;
            c.historical = histRes.rows;
        }
        const duration = req.query.duration ? parseInt(req.query.duration) : (Date.now() - start);
        res.render('search', { results: companies, elapsedSearch: duration, elapsedDelete: undefined, elapsedUpdate: undefined, lastQuery: q });
    } catch (err) {
        console.error('Search error:', err);
        res.status(500).send(err.message);
    }
}

async function main() {
    await ensureTables();
    app.get('/', async (req, res) => {
        const { uploadDuration, exportDurationSQL } = req.query;
        console.log('Upload duration:', uploadDuration, 'Export duration SQL:', exportDurationSQL);
        const bucket = storage.bucket(BUCKET_NAME);
        const [exists] = await bucket.exists();
        let files = [];
        if (exists) {
            const [filesList] = await bucket.getFiles();
            files = filesList.map(f => f.name);
        }
        res.render('upload', { files, uploadDuration: uploadDuration, exportDurationSQL: exportDurationSQL });
    });
    app.post('/upload', uploadHandler);
    app.post('/delete', deleteHandler);
    app.post('/company/delete', deleteCompanyHandler);
    app.post('/company/update', updateCompanyHandler);
    app.get('/search', (req, res) => {
        const { elapsedDelete, elapsedUpdate } = req.query;
        res.render('search', { results: [], elapsedSearch: undefined, elapsedDelete, elapsedUpdate, lastQuery: '' });
    });
    app.post('/search', searchHandler);
    const PORT = process.env.PORT || 8080;
    app.listen(PORT, () => console.log(`Server on port ${PORT}`));
}
main().catch(err => { console.error('Startup error:', err); process.exit(1); });