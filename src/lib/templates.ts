/**
 * Loads every module that registers an outbox message template, so any code path that sends
 * queued messages (drain route, cron, drainSoon) can render every kind of row (ADR-0024).
 */
import "./broadcasts";
import "./thank-yous";
import "./vendor-access";
