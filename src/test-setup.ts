// The tests make their own databases, each empty: a SQLite file named in the environment (`DATABASE_PATH`, say from a
// `.env` file) is never moved into one of them. The tests that move a file name it themselves.
delete process.env.DATABASE_PATH;
