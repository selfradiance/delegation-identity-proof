import { z } from "zod";

const Base64StringSchema = z
  .string()
  .min(1)
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    "Must be a valid base64 string"
  );

export const ExecuteDelegationPathParamsSchema = z
  .object({
    delegationId: z.string().uuid(),
  })
  .strict();

export const FinalizeDelegationActionPathParamsSchema = z
  .object({
    delegationId: z.string().uuid(),
    reservationId: z.string().uuid(),
  })
  .strict();

export const ExecuteDelegationAuthSchema = z
  .object({
    delegateId: Base64StringSchema,
    timestamp: z.string().datetime({ offset: true }),
    signature: Base64StringSchema,
  })
  .strict();

export const ExecuteDelegationRequestSchema = z
  .object({
    actionType: z.string().min(1),
    payload: z.unknown(),
    declaredExposureCents: z
      .number()
      .int()
      .positive("declaredExposureCents must be a positive integer"),
    auth: ExecuteDelegationAuthSchema,
  })
  .strict();

export const FinalizeDelegationActionRequestSchema = z
  .object({
    outcome: z.enum(["success", "failed"]),
  })
  .strict();

export type ExecuteDelegationPathParams = z.infer<
  typeof ExecuteDelegationPathParamsSchema
>;
export type FinalizeDelegationActionPathParams = z.infer<
  typeof FinalizeDelegationActionPathParamsSchema
>;
export type ExecuteDelegationRequest = z.infer<
  typeof ExecuteDelegationRequestSchema
>;
export type FinalizeDelegationActionRequest = z.infer<
  typeof FinalizeDelegationActionRequestSchema
>;

export function formatSchemaIssue(issuePath: (string | number)[]): string {
  if (issuePath.length === 0) {
    return "request";
  }

  return issuePath
    .map((part) => (typeof part === "number" ? `[${part}]` : part))
    .join(".");
}
