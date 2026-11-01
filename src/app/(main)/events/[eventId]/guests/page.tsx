import Link from "next/link";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, Input, LinkButton, PageHeader, Select, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { listFunctions } from "@/lib/functions";
import { cleanFilters, formatPhone, guestStats, HOUSEHOLDS_PER_PAGE, listGuests, listSavedViews, listTags } from "@/lib/guests";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { bulkInviteAction, deleteViewAction, saveViewAction } from "./actions";

const sideTone = { bride: "primary", groom: "success", both: "neutral" } as const;

export default async function GuestsPage({ params, searchParams }: PageProps<"/events/[eventId]/guests">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const db = getDb();
  const filters = cleanFilters(sp);
  const page = Math.max(1, Number(sp.page) || 1);
  const [result, stats, fns, tags, views] = await Promise.all([
    listGuests(db, eventId, filters, page),
    guestStats(db, eventId),
    listFunctions(db, eventId),
    listTags(db, eventId),
    listSavedViews(db, eventId),
  ]);
  const fnName = new Map(fns.map((f) => [f.id, f.name]));
  const canEdit = ctx.can("guests.edit");
  const base = `/events/${eventId}/guests`;
  const query = new URLSearchParams(filters as Record<string, string>).toString();
  const filtered = Object.keys(filters).length > 0;
  const pages = Math.max(1, Math.ceil(result.totalHouseholds / HOUSEHOLDS_PER_PAGE));
  const pageHref = (p: number) => `${base}?${new URLSearchParams({ ...filters, page: String(p) }).toString()}`;
  const hidden = Object.entries(filters).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("guests.title")}
        subtitle={t("guests.summary", { guests: stats.guests, households: stats.households })}
        action={
          <div className="flex flex-wrap gap-2">
            <a href={`${base}/export${query ? `?${query}` : ""}`} className={buttonClass("secondary")}>
              {t("guests.export")}
            </a>
            {canEdit && (
              <>
                <LinkButton href={`${base}/import`} variant="secondary">
                  {t("guests.import")}
                </LinkButton>
                <LinkButton href={`${base}/new`}>{t("guests.addHousehold")}</LinkButton>
              </>
            )}
          </div>
        }
      />

      {typeof sp.imported === "string" && /^\d+\.\d+\.\d+$/.test(sp.imported) && (
        <Alert tone="success">
          {(() => {
            const [guests, households, skipped] = sp.imported.split(".");
            return t("importer.done", { guests, households, skipped });
          })()}
        </Alert>
      )}

      {stats.guests > 0 && (
        <div className="grid gap-1 text-sm text-muted sm:grid-cols-3">
          <p>{t("guests.stats", stats)}</p>
          <p>{t("guests.ageStats", stats)}</p>
          {stats.uninvited > 0 && (
            <Link href={`${base}?fn=none`} className="text-warning hover:underline">
              {t("guests.uninvited", { count: stats.uninvited })}
            </Link>
          )}
        </div>
      )}

      {/* Filters */}
      <Card>
        <form className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" role="search">
          <Input name="q" defaultValue={filters.q ?? ""} placeholder={t("guests.search")} aria-label={t("guests.search")} className="sm:col-span-2" />
          <Select name="side" defaultValue={filters.side ?? ""} aria-label={t("household.side")}>
            <option value="">{t("guests.anySide")}</option>
            {(["bride", "groom", "both"] as const).map((s) => (
              <option key={s} value={s}>
                {t(`sides.${s}`)}
              </option>
            ))}
          </Select>
          <Select name="fn" defaultValue={filters.fn ?? ""} aria-label={t("guests.invitedTo")}>
            <option value="">{t("guests.anyFunction")}</option>
            {fns.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
            <option value="none">{t("guests.notInvited")}</option>
          </Select>
          <Select name="tag" defaultValue={filters.tag ?? ""} aria-label={t("guestForm.tags")}>
            <option value="">{t("guests.anyTag")}</option>
            {tags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </Select>
          <Select name="age" defaultValue={filters.age ?? ""} aria-label={t("guestForm.ageGroup")}>
            <option value="">{t("guests.anyAge")}</option>
            {(["adult", "child", "infant"] as const).map((a) => (
              <option key={a} value={a}>
                {t(`ages.${a}`)}
              </option>
            ))}
          </Select>
          <Select name="diet" defaultValue={filters.diet ?? ""} aria-label={t("guestForm.diet")}>
            <option value="">{t("guests.anyDiet")}</option>
            {(["veg", "non_veg", "jain", "vegan", "other"] as const).map((d) => (
              <option key={d} value={d}>
                {t(`diets.${d}`)}
              </option>
            ))}
            <option value="unknown">{t("guests.dietUnknown")}</option>
          </Select>
          <Select name="rsvp" defaultValue={filters.rsvp ?? ""} aria-label={t("rsvp.title")}>
            <option value="">{t("rsvp.anyRsvp")}</option>
            {(["attending", "maybe", "declined", "pending"] as const).map((r) => (
              <option key={r} value={r}>
                {t(`rsvp.${r}`)}
              </option>
            ))}
          </Select>
          <Select name="travel" defaultValue={filters.travel ?? ""} aria-label={t("travel.title")}>
            <option value="">{t("rsvp.travelAny")}</option>
            <option value="submitted">{t("rsvp.travelSubmitted")}</option>
            <option value="missing">{t("rsvp.travelMissing")}</option>
            <option value="pickup">{t("rsvp.travelPickup")}</option>
          </Select>
          <div className="flex gap-2">
            <button type="submit" className={buttonClass("primary", "flex-1")}>
              {t("guests.filter")}
            </button>
            {filtered && (
              <Link href={base} className={buttonClass("ghost")}>
                {t("guests.clear")}
              </Link>
            )}
          </div>
        </form>

        {(views.length > 0 || filtered) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-sm">
            {views.length > 0 && <span className="text-muted">{t("guests.savedViews")}:</span>}
            {views.map((v) => (
              <span key={v.id} className="inline-flex items-center rounded-full border border-border">
                <Link href={`${base}?${new URLSearchParams(v.filters).toString()}`} className="py-1.5 pl-3 pr-1 hover:text-primary">
                  {v.name}
                </Link>
                {canEdit && (
                  <form action={deleteViewAction.bind(null, eventId, v.id)}>
                    <button type="submit" aria-label={`${t("guests.deleteView")}: ${v.name}`} className="min-h-8 px-2 text-muted hover:text-danger">
                      ×
                    </button>
                  </form>
                )}
              </span>
            ))}
            {filtered && (
              <SimpleForm action={saveViewAction.bind(null, eventId)} className="ml-auto flex items-center gap-2">
                {hidden}
                <Input name="viewName" placeholder={t("guests.viewName")} aria-label={t("guests.viewName")} className="min-h-9 w-40 text-sm" maxLength={60} required />
                <SubmitButton variant="secondary" className="min-h-9">
                  {t("guests.saveView")}
                </SubmitButton>
              </SimpleForm>
            )}
          </div>
        )}
      </Card>

      {/* Bulk invite for everyone matching */}
      {canEdit && fns.length > 0 && result.matchingGuests > 0 && filtered && (
        <Card>
          <SimpleForm action={bulkInviteAction.bind(null, eventId)} className="flex flex-wrap items-center gap-2 text-sm">
            {hidden}
            <span className="font-medium">
              {t("guests.bulkTitle")} ({result.matchingGuests}):
            </span>
            <Select name="op" defaultValue="add" className="min-h-10 w-auto" aria-label={t("guests.bulkInvite")}>
              <option value="add">{t("guests.bulkInvite")}</option>
              <option value="remove">{t("guests.bulkUninvite")}</option>
            </Select>
            <Select name="functionId" className="min-h-10 w-auto" aria-label={t("guests.invitedTo")}>
              {fns.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
            <SubmitButton variant="secondary" className="min-h-10">
              {t("guests.bulkApply")}
            </SubmitButton>
          </SimpleForm>
        </Card>
      )}

      {/* Results */}
      {stats.guests === 0 ? (
        <Card>
          <p className="text-muted">{t("guests.empty")}</p>
        </Card>
      ) : result.households.length === 0 ? (
        <Card>
          <p className="text-muted">{t("guests.noMatches")}</p>
        </Card>
      ) : (
        <>
          {filtered && <p className="text-sm text-muted">{t("guests.matching", { guests: result.matchingGuests })}</p>}
          <ul className="space-y-3">
            {result.households.map((h) => (
              <li key={h.id}>
                <Card className="p-0 sm:p-0">
                  <Link href={`${base}/${h.id}`} className="flex flex-wrap items-center gap-2 rounded-t-xl px-4 py-3 hover:bg-surface-muted">
                    <span className="font-semibold">{h.name}</span>
                    <Badge tone={sideTone[h.side]}>{t(`sides.${h.side}`)}</Badge>
                    {h.city && <span className="text-sm text-muted">{h.city}</span>}
                  </Link>
                  <ul className="divide-y divide-border border-t border-border">
                    {h.members.map((m) => (
                      <li key={m.id} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-1.5">
                            <span>{m.name}</span>
                            {m.isHead && <Badge tone="primary">{t("guests.head")}</Badge>}
                            {m.ageGroup !== "adult" && <Badge>{t(`ages.${m.ageGroup}`)}</Badge>}
                            {m.diet && <Badge tone="success">{t(`diets.${m.diet}`)}</Badge>}
                            {m.tags.map((tag) => (
                              <Badge key={tag} tone="warning">
                                {tag}
                              </Badge>
                            ))}
                          </p>
                          <p className="text-sm text-muted">{[m.relation, formatPhone(m.phone)].filter(Boolean).join(" · ")}</p>
                        </div>
                        <p className="text-sm sm:max-w-[45%] sm:text-right">
                          {m.functionIds.length ? (
                            <span className="text-muted">{m.functionIds.map((id) => fnName.get(id)).filter(Boolean).join(", ")}</span>
                          ) : (
                            <span className="text-warning">{t("guests.notInvitedShort")}</span>
                          )}
                        </p>
                      </li>
                    ))}
                  </ul>
                </Card>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav aria-label="Pagination" className="flex items-center justify-between gap-2 text-sm">
              {page > 1 ? (
                <Link href={pageHref(page - 1)} className={buttonClass("secondary")}>
                  ← {t("guests.previous")}
                </Link>
              ) : (
                <span />
              )}
              <span className="text-muted">{t("guests.page", { page, pages })}</span>
              {page < pages ? (
                <Link href={pageHref(page + 1)} className={buttonClass("secondary")}>
                  {t("guests.next")} →
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
