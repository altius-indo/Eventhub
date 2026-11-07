import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardTitle, Field, Input, Select } from "@/components/ui";
import { getDb } from "@/db";
import { listIdentifiers } from "@/lib/auth-core";
import { listMembers, listOpenInvitations } from "@/lib/events";
import { formatIdentifier } from "@/lib/identifiers";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { inviteAction, removeMemberAction, revokeInvitationAction, updateMemberAction } from "./actions";

export default async function MembersPage({ params }: PageProps<"/events/[eventId]/members">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const db = getDb();
  const canManage = ctx.can("members.manage");
  const members = await listMembers(db, eventId);
  const invitations = canManage ? await listOpenInvitations(db, eventId) : [];
  const identifiers = await listIdentifiers(db, members.map((m) => m.user.id));

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        <Card>
          <CardTitle>{t("members.title")}</CardTitle>
          <ul className="divide-y divide-border">
            {members.map(({ member, user }) => {
              const ids = identifiers.filter((i) => i.userId === user.id).map(formatIdentifier);
              const isSelf = user.id === ctx.user.id;
              return (
                <li key={member.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{user.name}</span>
                    {isSelf && <span className="text-sm text-muted">({t("members.you")})</span>}
                    <Badge tone={member.role === "host" ? "primary" : "neutral"}>{t(`roles.${member.role}`)}</Badge>
                  </div>
                  {canManage && <p className="mt-0.5 break-all text-sm text-muted">{ids.join(" · ")}</p>}
                  {canManage && (
                    <div className="mt-2 flex flex-wrap items-start gap-2">
                      <SimpleForm action={updateMemberAction.bind(null, eventId)} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="userId" value={user.id} />
                        <label className="text-sm">
                          <span className="sr-only">{t("members.role")}</span>
                          <Select name="role" defaultValue={member.role} className="min-h-10 w-auto text-sm">
                            <option value="host">{t("roles.host")}</option>
                            <option value="planner">{t("roles.planner")}</option>
                          </Select>
                        </label>
                        <SubmitButton variant="secondary" className="min-h-10">
                          {t("common.save")}
                        </SubmitButton>
                      </SimpleForm>
                      <SimpleForm action={removeMemberAction.bind(null, eventId)} className="flex flex-col gap-2">
                        <input type="hidden" name="userId" value={user.id} />
                        <SubmitButton variant="ghost" className="min-h-10 text-danger">
                          {t("common.remove")}
                        </SubmitButton>
                      </SimpleForm>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>

        {canManage && invitations.length > 0 && (
          <Card>
            <CardTitle>{t("members.pending")}</CardTitle>
            <ul className="divide-y divide-border">
              {invitations.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div>
                    <p className="break-all">{formatIdentifier({ type: inv.identifierType, value: inv.identifierValue })}</p>
                    <p className="text-sm text-muted">{t("members.invitedAs", { role: t(`roles.${inv.role}`) })}</p>
                  </div>
                  <form action={revokeInvitationAction.bind(null, eventId)}>
                    <input type="hidden" name="invitationId" value={inv.id} />
                    <SubmitButton variant="ghost" className="min-h-10">
                      {t("members.revoke")}
                    </SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div className="space-y-4">
        {canManage && (
          <Card>
            <CardTitle>{t("members.invite")}</CardTitle>
            <SimpleForm action={inviteAction.bind(null, eventId)}>
              <Field label={t("members.identifier")} htmlFor="identifier">
                <Input id="identifier" name="identifier" required placeholder={t("auth.login.identifierPlaceholder")} />
              </Field>
              <Field label={t("members.role")} htmlFor="role">
                <Select id="role" name="role" defaultValue="planner">
                  <option value="planner">{t("roles.planner")}</option>
                  <option value="host">{t("roles.host")}</option>
                </Select>
              </Field>
              <SubmitButton className="w-full">{t("members.sendInvite")}</SubmitButton>
            </SimpleForm>
          </Card>
        )}
        <Card className="space-y-2 text-sm text-muted">
          <p>
            <strong className="text-text">{t("roles.host")}:</strong> {t("members.hostHelp")}
          </p>
          <p>
            <strong className="text-text">{t("roles.planner")}:</strong> {t("members.plannerHelp")}
          </p>
        </Card>
      </div>
    </div>
  );
}
