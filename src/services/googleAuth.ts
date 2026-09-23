import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env";
import { badRequest, serviceUnavailable } from "../utils/errors";

let client: OAuth2Client | null = null;

function getClient(): OAuth2Client {
  if (!env.GOOGLE_CLIENT_ID) {
    throw serviceUnavailable("google sign in is not set up yet", "google_not_configured");
  }
  client ??= new OAuth2Client(env.GOOGLE_CLIENT_ID);
  return client;
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

/** verifies the id token against google and returns only what we need from it. */
export async function verifyGoogleCredential(credential: string): Promise<GoogleProfile> {
  const ticket = await getClient()
    .verifyIdToken({ idToken: credential, audience: env.GOOGLE_CLIENT_ID })
    .catch(() => {
      throw badRequest("that google sign in could not be verified, please try again");
    });

  const payload = ticket.getPayload();
  if (!payload?.email) throw badRequest("google did not share an email address");

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: Boolean(payload.email_verified),
    name: payload.name,
    picture: payload.picture,
  };
}
