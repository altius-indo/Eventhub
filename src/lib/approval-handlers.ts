/**
 * Registers the change types that go through Host approval. Feature modules
 * (services & requirements in M5, budget, bookings, payments) add their
 * handlers here, e.g.:
 *
 *   registerApprovalHandler("requirement.create", { permission: "services.edit", apply: ... })
 *
 * Milestone 1 ships the engine, queue and decisions; no change types exist yet.
 */
export {};
