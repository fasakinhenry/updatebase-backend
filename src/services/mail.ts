import { Resend } from "resend";
import { env } from "../config/env";
import { logger } from "../config/logger";

let client: Resend | null = null;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  client ??= new Resend(env.RESEND_API_KEY);
  return client;
}

interface SendOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * sends, or logs when no key is configured.
 *
 * logging rather than throwing means the whole product is usable in
 * development without an email provider, and an invite never fails the request
 * that created it.
 */
async function send({ to, subject, html, text }: SendOptions): Promise<boolean> {
  const resend = getClient();

  if (!resend) {
    logger.info({ to, subject, text }, "email not sent, RESEND_API_KEY is empty");
    return false;
  }

  try {
    const { error } = await resend.emails.send({
      from: env.MAIL_FROM,
      to,
      subject,
      html,
      text,
    });

    if (error) {
      logger.error({ err: error, to, subject }, "email provider rejected the message");
      return false;
    }
    return true;
  } catch (error) {
    logger.error({ err: error, to, subject }, "failed to send email");
    return false;
  }
}

/**
 * one plain layout for every email we send. inline styles only, because email
 * clients strip stylesheets, and a light background because most clients
 * render dark mode unpredictably.
 */
function layout(options: { heading: string; body: string; cta?: { label: string; url: string } }) {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:32px 16px;background:#f6f8fc;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0b1220">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e4e9f1;border-radius:16px">
      <tr>
        <td style="padding:32px">
          <p style="margin:0 0 24px;font-size:17px;font-weight:600;letter-spacing:-0.5px">updatebase</p>
          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:600">${options.heading}</h1>
          <div style="font-size:15px;line-height:1.6;color:#46536a">${options.body}</div>
          ${
            options.cta
              ? `<p style="margin:28px 0 0">
                   <a href="${options.cta.url}" style="display:inline-block;padding:12px 22px;background:#287bff;color:#ffffff;text-decoration:none;border-radius:10px;font-size:15px;font-weight:500">${options.cta.label}</a>
                 </p>
                 <p style="margin:20px 0 0;font-size:13px;color:#6f7c92">or paste this into your browser:<br><span style="color:#287bff;word-break:break-all">${options.cta.url}</span></p>`
              : ""
          }
        </td>
      </tr>
    </table>
    <p style="max-width:520px;margin:20px auto 0;font-size:12px;color:#6f7c92;text-align:center">
      you are getting this because someone used your address on updatebase. if that was not you, ignore it.
    </p>
  </body>
</html>`;
}

export function sendInviteEmail(options: {
  to: string;
  organizationName: string;
  inviterName: string;
  role: string;
  code: string;
  message?: string;
}): Promise<boolean> {
  const url = `${env.CLIENT_URL.split(",")[0]}/invite/${options.code}`;

  const body = [
    `<p style="margin:0 0 12px">${options.inviterName} wants you to post for <strong>${options.organizationName}</strong> on updatebase as a ${options.role}.</p>`,
    options.message
      ? `<p style="margin:0 0 12px;padding:12px 16px;background:#f6f8fc;border-radius:10px;font-style:italic">${options.message}</p>`
      : "",
    `<p style="margin:0">updatebase turns an opportunity you paste into a branded, numbered update your community will actually read. you will need an account, which takes a couple of minutes.</p>`,
  ].join("");

  return send({
    to: options.to,
    subject: `${options.inviterName} invited you to post for ${options.organizationName}`,
    html: layout({
      heading: `you have been invited to ${options.organizationName}`,
      body,
      cta: { label: "accept the invite", url },
    }),
    text: `${options.inviterName} invited you to post for ${options.organizationName} on updatebase as a ${options.role}.\n\n${options.message ?? ""}\n\naccept here: ${url}`,
  });
}

export function sendPasswordResetEmail(options: {
  to: string;
  token: string;
}): Promise<boolean> {
  const url = `${env.CLIENT_URL.split(",")[0]}/auth/reset?token=${options.token}`;

  return send({
    to: options.to,
    subject: "reset your updatebase password",
    html: layout({
      heading: "reset your password",
      body: `<p style="margin:0">this link works once and expires in an hour. if you did not ask for it, nothing has changed and you can ignore this.</p>`,
      cta: { label: "choose a new password", url },
    }),
    text: `reset your updatebase password here: ${url}\n\nthis link works once and expires in an hour.`,
  });
}

export function sendVerifyEmail(options: { to: string; token: string }): Promise<boolean> {
  const url = `${env.CLIENT_URL.split(",")[0]}/auth/verify?token=${options.token}`;

  return send({
    to: options.to,
    subject: "confirm your email address",
    html: layout({
      heading: "confirm your email",
      body: `<p style="margin:0">one tap and you are done. this is how we reach you when something needs your attention.</p>`,
      cta: { label: "confirm my email", url },
    }),
    text: `confirm your updatebase email here: ${url}`,
  });
}
