import { config } from "dotenv";

config({ quiet: true });
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://eventhub:eventhub@localhost:5432/eventhub_test";
process.env.AUTH_SECRET ??= "test-secret-test-secret-test-secret";
process.env.EMAIL_PROVIDER = "dev";
process.env.PHONE_PROVIDER = "dev";
process.env.APP_ADMIN_IDENTIFIERS = "admin@example.com";
