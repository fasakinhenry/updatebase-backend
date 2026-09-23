import type { NextFunction, Request, Response } from "express";
import { Membership, type MembershipDoc } from "../models/Membership";
import { Organization, type OrganizationDoc } from "../models/Organization";
import { forbidden, notFound, unauthorized } from "../utils/errors";
import { ROLE_RANK, type OrgRole } from "../types/domain";

declare global {
  namespace Express {
    interface Request {
      organization?: OrganizationDoc;
      membership?: MembershipDoc;
    }
  }
}

/**
 * loads the organization named in the route and the caller's membership of it,
 * then checks the caller outranks the minimum the route needs.
 *
 * roles are ranked rather than compared by name, so "at least an admin" is one
 * comparison instead of a list that has to be kept in step everywhere.
 */
export function requireRole(minimum: OrgRole = "delegate") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.userId) throw unauthorized();

      const id = String(req.params.organizationId ?? req.params.id);

      const organization = await Organization.findOne({ _id: id, suspendedAt: null });
      if (!organization) throw notFound("we could not find that organization");

      const membership = await Membership.findOne({
        user: req.userId,
        organization: organization._id,
        removedAt: null,
      });

      if (!membership) throw forbidden("you are not part of that organization");

      if (ROLE_RANK[membership.role as OrgRole] < ROLE_RANK[minimum]) {
        throw forbidden(
          minimum === "owner"
            ? "only the owner can do that"
            : "you need to be an admin to do that",
        );
      }

      req.organization = organization;
      req.membership = membership;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** true when this member may publish to this channel. */
export function canPublishTo(membership: MembershipDoc, channel: string): boolean {
  // owners and admins are not restricted to an assigned set
  if (membership.role !== "delegate") return true;
  // a delegate with nothing assigned can still post to updatebase itself
  if (!membership.channels?.length) return channel === "updatebase";
  return membership.channels.includes(channel as never);
}
