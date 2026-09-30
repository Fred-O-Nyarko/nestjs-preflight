import { IsInt, Max, Min } from 'class-validator';
export class ListUsersQuery {
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
