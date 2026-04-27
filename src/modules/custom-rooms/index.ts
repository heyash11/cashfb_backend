export {
  CustomRoomsService,
  type CustomRoomsServiceDeps,
  type GetResultResult,
  type GetResultTile,
  type ListRoomsInput,
  type ListRoomsItem,
} from './custom-rooms.service.js';
export type { Tier } from '../../shared/models/_tier.js';
export {
  AdminCustomRoomsService,
  type AdminCreateRoomInput,
  type AdminCustomRoomsServiceDeps,
  type AdminEnterResultsBucket,
  type AdminEnterResultsInput,
  type AdminListRoomsFilter,
  type AdminListRoomsResult,
  type AdminSetCredentialsInput,
  type AssignWinnersInput,
  type AssignWinnersInputItem,
  type AssignWinnersResult,
  type WinnerType,
} from './custom-rooms.admin.service.js';
export { CustomRoomsController } from './custom-rooms.controller.js';
export { createCustomRoomsRouter } from './custom-rooms.routes.js';
export {
  ListRoomsQuerySchema,
  RoomIdParamsSchema,
  type ListRoomsQuery,
  type RoomIdParams,
} from './custom-rooms.schemas.js';
