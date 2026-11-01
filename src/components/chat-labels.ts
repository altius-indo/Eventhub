import type { Translator } from "@/i18n/core";
import type { ChatRoomLabels } from "./chat-room";

/** Translated strings for the chat client component (built on the server). */
export function chatLabels(t: Translator, maxMb: number): ChatRoomLabels {
  return {
    messageLabel: t("chat.messageLabel"),
    placeholder: t("chat.placeholder"),
    send: t("chat.send"),
    attach: t("chat.attach"),
    attached: t("chat.attached"),
    removeAttachment: t("chat.removeAttachment"),
    delete: t("chat.delete"),
    deleteConfirm: t("chat.deleteConfirm"),
    deleted: t("chat.deleted"),
    mentionPick: t("chat.mentionPick"),
    vendorTag: t("chat.vendorTag"),
    offline: t("chat.offline"),
    signedOut: t("chat.signedOut"),
    logIn: t("chat.logIn"),
    readOnly: t("chat.readOnly"),
    noMessages: t("chat.noMessages"),
    attachHelp: t("chat.attachHelp", { size: maxMb }),
    pollingHelp: t("chat.pollingHelp"),
    errors: {
      not_found: t("chat.errors.not_found"),
      invalid: t("chat.errors.invalid"),
      too_long: t("chat.errors.too_long"),
      forbidden: t("chat.errors.forbidden"),
      failed: t("chat.errors.failed"),
      too_large: t("documents.errors.too_large", { size: maxMb }),
      bad_type: t("documents.errors.bad_type"),
      quota: t("documents.errors.quota"),
    },
  };
}
