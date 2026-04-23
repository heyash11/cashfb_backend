import type { Request, Response } from 'express';
import type { AdminDashboardService } from './admin-dashboard.service.js';

export class AdminDashboardController {
  constructor(private readonly service: AdminDashboardService) {}

  metrics = async (_req: Request, res: Response): Promise<void> => {
    const result = await this.service.getMetrics();
    res.json({
      success: true,
      data: result.data,
      generatedAt: result.generatedAt,
      cached: result.cached,
    });
  };
}
