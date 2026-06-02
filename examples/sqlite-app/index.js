// Exercises the better-sqlite3 NATIVE addon: if this runs inside the packed
// bytecode binary, native embedding + extraction + load all worked.
const Database = require('better-sqlite3')

const db = new Database(':memory:')
db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
const insert = db.prepare('INSERT INTO users (name) VALUES (?)')
for (const name of ['alice', 'bob', 'carol']) insert.run(name)

const rows = db.prepare('SELECT * FROM users ORDER BY id').all()
const ver = db.prepare('SELECT sqlite_version() AS v').get()

console.log('✅ SQLite native addon works inside the protected binary!')
console.log('   sqlite engine version:', ver.v)
console.log('   rows:', JSON.stringify(rows))
db.close()
