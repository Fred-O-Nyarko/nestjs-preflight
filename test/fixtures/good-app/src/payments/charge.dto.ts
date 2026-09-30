import { IsInt, IsPositive, IsString } from 'class-validator';
export class ChargeDto {
  @IsInt() @IsPositive() amount: number;
  @IsString() currency: string;
}
