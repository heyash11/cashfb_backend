export {
  AdminPostService,
  type AdminPostCreateInput,
  type AdminPostServiceDeps,
  type AdminPostUpdateInput,
} from './posts.admin.service.js';
export { PostController } from './posts.controller.js';
export { createPostsRouter } from './posts.routes.js';
export {
  ListPostsQuerySchema,
  PostIdParamsSchema,
  type ListPostsQuery,
  type PostIdParams,
} from './posts.schemas.js';
export { PostService, type PostServiceDeps, type UserFacingPostDto } from './posts.service.js';
