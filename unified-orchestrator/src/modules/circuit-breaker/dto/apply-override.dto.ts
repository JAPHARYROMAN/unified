import { BreakerScope, BreakerTrigger } from "@prisma/client";

export class ApplyOverrideDto {
  trigger!: BreakerTrigger;
  scope!: BreakerScope;
  partnerId?: string;
  reason!: string;
  /** Minutes until override expires. Max 10080 (7 days). */
  expiresInMinutes!: number;
}
