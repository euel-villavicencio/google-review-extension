import os
from pathlib import Path

import psycopg

from app import normalize_database_url


def main():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")

    schema_path = Path(__file__).with_name("schema.sql")
    schema = schema_path.read_text(encoding="utf-8")

    with psycopg.connect(normalize_database_url(database_url)) as connection:
        connection.execute(schema)

    print("Database schema is ready.")


if __name__ == "__main__":
    main()
