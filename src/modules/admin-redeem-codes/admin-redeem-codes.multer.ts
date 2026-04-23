import multer from 'multer';
import { ValidationError } from '../../shared/errors/AppError.js';

/** 10 MB — comfortably more than the largest expected supplier drop. */
export const CSV_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Multer middleware for the CSV upload endpoint. Belt-and-suspenders
 * file type check: BOTH `Content-Type: text/csv` (or
 * `application/vnd.ms-excel` which some clients send) AND `.csv`
 * extension must match. Either mismatch → 400.
 *
 * In-memory storage so the request hits the service with a Buffer —
 * the parse + encrypt path consumes it synchronously and never
 * writes to disk.
 */
export const csvUploadHandler = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CSV_UPLOAD_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mimeOk = file.mimetype === 'text/csv' || file.mimetype === 'application/vnd.ms-excel';
    const extOk = file.originalname.toLowerCase().endsWith('.csv');
    if (!mimeOk || !extOk) {
      cb(
        new ValidationError('Upload must be a .csv file with matching Content-Type', {
          receivedMime: file.mimetype,
          receivedName: file.originalname,
        }),
      );
      return;
    }
    cb(null, true);
  },
}).single('file');
