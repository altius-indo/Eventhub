import Link from "next/link";
import { Badge, Card, Field, LinkButton, PageHeader, Select, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { ensureCatalogue, listServiceTypes } from "@/lib/catalogue";
import { isUuid } from "@/lib/ids";
import { listVendors } from "@/lib/vendors";
import { getEventContext } from "@/lib/server/event-context";
import { typeLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";

export default async function VendorsPage({ params, searchParams }: PageProps<"/events/[eventId]/vendors">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  await ensureCatalogue(db, eventId, locale);
  const typeId = typeof sp.type === "string" && isUuid(sp.type) ? sp.type : undefined;
  const archived = sp.archived === "1";
  const [types, vendors] = await Promise.all([listServiceTypes(db, eventId, "service"), listVendors(db, eventId, { serviceTypeId: typeId, includeArchived: archived })]);
  const name = (id: string) => {
    const ty = types.find((x) => x.id === id);
    return ty ? typeLabel(t, { typeKey: ty.systemKey, typeName: ty.name }) : "";
  };
  return (
    <div className="space-y-4">
      <PageHeader
        title={t("vendors.title")}
        action={ctx.can("vendors.edit") ? <LinkButton href={`/events/${eventId}/vendors/new`}>{t("vendors.add")}</LinkButton> : undefined}
      />
      <form className="flex flex-wrap items-end gap-2" role="search">
        <Field label={t("vendors.filterType")} htmlFor="f-type">
          <Select id="f-type" name="type" defaultValue={typeId ?? ""}>
            <option value="">{t("vendors.allTypes")}</option>
            {types.map((ty) => (
              <option key={ty.id} value={ty.id}>
                {name(ty.id)}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="archived" value="1" defaultChecked={archived} className="h-5 w-5" />
          {t("vendors.showArchived")}
        </label>
        <button type="submit" className={buttonClass("secondary")}>
          {t("approvals.filter")}
        </button>
      </form>
      <Card>
        {vendors.length === 0 ? (
          <p className="text-muted">{t("vendors.empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {vendors.map((v) => (
              <li key={v.id}>
                <Link href={`/events/${eventId}/vendors/${v.id}`} className="flex min-h-11 flex-wrap items-center gap-2 py-2 hover:text-primary">
                  <span className="font-medium">{v.name}</span>
                  {v.archivedAt && <Badge>{t("vendors.archived")}</Badge>}
                  {v.rating != null && <Badge tone="primary">{"★".repeat(v.rating)}</Badge>}
                  <span className="text-sm text-muted">{v.typeIds.map(name).filter(Boolean).join(", ")}</span>
                  {v.phone && <span className="text-sm text-muted">{v.phone}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
