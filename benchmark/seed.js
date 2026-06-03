const postgres = require('postgres');
const { faker } = require('@faker-js/faker');
const fs = require('fs');
const path = require('path');

const connectionString = 'postgres://benchmark_user:benchmark_password@localhost:5439/benchmark_db';
const sql = postgres(connectionString, { max: 10 });

async function main() {
    console.log('Connecting to database and setting up schema...');
    
    // Apply schema
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await sql.unsafe(schemaSql);
    
    const TOTAL_ROWS = 1000000;
    const BATCH_SIZE = 5000;
    const totalBatches = TOTAL_ROWS / BATCH_SIZE;

    console.log(`Seeding ${TOTAL_ROWS} rows in batches of ${BATCH_SIZE}...`);
    
    const startTime = Date.now();
    
    for (let i = 0; i < totalBatches; i++) {
        const batch = [];
        for (let j = 0; j < BATCH_SIZE; j++) {
            batch.push({
                uuid: faker.string.uuid(),
                name: faker.person.fullName(),
                email: faker.internet.email(),
                metadata: {
                    city: faker.location.city(),
                    company: faker.company.name(),
                    role: faker.person.jobTitle()
                }
            });
        }

        // Insert batch
        await sql`
            INSERT INTO users ${sql(batch, 'uuid', 'name', 'email', 'metadata')}
        `;

        if ((i + 1) % 20 === 0 || i + 1 === totalBatches) {
            const pct = (((i + 1) / totalBatches) * 100).toFixed(1);
            const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`Progress: ${pct}% (${(i + 1) * BATCH_SIZE} / ${TOTAL_ROWS} rows seeded in ${elapsedSec}s)`);
        }
    }

    console.log(`Seeding completed in ${((Date.now() - startTime) / 1000).toFixed(2)}s.`);
    await sql.end();
}

main().catch(err => {
    console.error('Seeding failed:', err);
    process.exit(1);
});
