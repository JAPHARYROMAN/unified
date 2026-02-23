import { IsObject, IsNotEmptyObject } from "class-validator";

export class SubmitPartnerDto {
  @IsObject()
  @IsNotEmptyObject()
  payload: Record<string, unknown>;
}
