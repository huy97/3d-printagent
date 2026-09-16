import { rmSync } from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import { PATHS, ensureDataDirs } from '../../core/paths.js';
import { getConfig } from '../../core/config.js';
import * as library from '../../core/library.js';
import * as jobs from '../../core/jobs.js';
import * as slicer from '../../core/slicer.js';
import * as advisor from '../../core/advisor.js';
import * as slicechat from '../../core/slicechat.js';
import { shortId } from '../../util/id.js';
import { badRequest } from '../../util/errors.js';
import { localeFromRequest } from '../../i18n/index.js';
import { requestOrigin, wrap } from './helpers.js';

export const filesRouter = Router();
export const printRouter = Router();

const storage = multer.diskStorage({
  destination: (req, file, done) => {
    ensureDataDirs();
    done(null, PATHS.tmp);
  },
  filename: (req, file, done) => done(null, shortId('up')),
});

/** Nhận một file multipart ở field `file`; giới hạn dung lượng đọc lại từ cấu hình mỗi lần. */
function receiveUpload(req, res, next) {
  if (!req.is('multipart/form-data')) {
    next();
    return;
  }
  const limit = Math.max(1, Number(getConfig().files.maxUploadMb) || 1024) * 1024 * 1024;
  multer({ storage, limits: { fileSize: limit, files: 1 }, defParamCharset: 'utf8' }).single('file')(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (req.file?.path) rmSync(req.file.path, { force: true });
    if (error.code === 'LIMIT_FILE_SIZE') {
      next(badRequest('error.file_too_large', { limit: getConfig().files.maxUploadMb }));
      return;
    }
    next(badRequest('error.upload_failed', { message: error.message }));
  });
}

async function ingest(req) {
  const origin = requestOrigin(req);
  if (req.file) {
    return library.addFromPath(req.file.path, req.body?.name || req.file.originalname, { origin });
  }
  if (req.body?.fileId) return library.getFile(req.body.fileId);
  return library.addFile({ ...req.body, origin });
}

function printOptions(body = {}) {
  const options = { ...body };
  for (const key of ['useAms', 'timelapse', 'bedLeveling', 'flowCalibration', 'confirmBedClear']) {
    if (options[key] === 'true') options[key] = true;
    if (options[key] === 'false') options[key] = false;
  }
  if (typeof options.amsMapping === 'string') {
    options.amsMapping = options.amsMapping.split(',').map((value) => Number(value.trim()));
  }
  return options;
}

filesRouter.get('/', (req, res) => {
  res.json({
    files: library.listFiles({
      search: req.query.search,
      format: req.query.format,
      limit: req.query.limit,
      sourceId: req.query.sourceId,
      derived: req.query.derived === undefined ? undefined : req.query.derived !== 'false',
    }),
    summary: library.librarySummary(),
  });
});

filesRouter.post(
  '/',
  receiveUpload,
  wrap(async (req, res) => {
    const file = await ingest(req);
    const body = printOptions(req.body);
    let job = null;
    if (typeof body.printerIds === 'string') body.printerIds = body.printerIds.split(',').filter(Boolean);
    if (body.printerId && (body.print === true || body.print === 'true' || body.mode)) {
      job = await jobs.createJob({ ...body, fileId: file.id, origin: requestOrigin(req) });
    }
    res.status(201).json(job ? { file, job } : file);
  }),
);

filesRouter.get('/:id', (req, res) => {
  res.json(library.getFile(req.params.id));
});

filesRouter.get('/:id/download', (req, res) => {
  const file = library.getFileRecord(req.params.id);
  res.download(library.filePath(file), file.name);
});

filesRouter.get('/:id/thumbnail', (req, res) => {
  const file = library.getFileRecord(req.params.id);
  const thumb = library.thumbnailPath(file);
  if (!thumb) {
    res.status(404).end();
    return;
  }
  res.setHeader('cache-control', 'private, max-age=86400');
  res.type(file.thumbMime ?? 'image/png');
  res.sendFile(thumb);
});

filesRouter.get('/:id/plate', (req, res) => {
  res.json(library.platePreview(req.params.id, req.query.plate));
});

filesRouter.get('/:id/plate-image', (req, res) => {
  res.setHeader('cache-control', 'private, max-age=86400');
  res.type('image/png').send(library.plateImage(req.params.id, req.query.plate));
});

filesRouter.get('/:id/mesh', (req, res) => {
  res.setHeader('cache-control', 'private, max-age=86400');
  const bed = slicer.machineBed({ machine: req.query.machine, printerId: req.query.printerId });
  res.type('application/octet-stream').send(library.plateMesh(req.params.id, req.query.plate, { bed }));
});

filesRouter.get('/:id/toolpath', (req, res) => {
  res.setHeader('cache-control', 'private, max-age=86400');
  res.type('application/octet-stream').send(library.plateToolpath(req.params.id, req.query.plate));
});

/** Tách mô hình nhiều khối rời thành các vật thể riêng, kết quả là một file 3MF mới trong thư viện. */
filesRouter.post(
  '/:id/analyze',
  wrap(async (req, res) => {
    res.json(
      await advisor.analyzePrint({
        fileId: req.params.id,
        printerId: req.body?.printerId ?? null,
        plate: req.body?.plate,
        note: req.body?.note,
        locale: localeFromRequest(req),
      }),
    );
  }),
);

filesRouter.post('/:id/split', (req, res) => {
  res.status(201).json(library.splitFile(req.params.id));
});

/** Khoảng hở và lề nhận từ người dùng, kẹp lại cho khỏi âm hay lớn hơn nửa bàn. */
function spacing(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : fallback;
}

/** Xếp lại các khối lên bàn in theo kích thước chuẩn của máy sẽ in. */
filesRouter.post('/:id/arrange', (req, res) => {
  const bed = slicer.machineBed({ machine: req.body?.machine, printerId: req.body?.printerId });
  const options = {
    gap: spacing(req.body?.gap, undefined),
    margin: spacing(req.body?.margin, undefined),
    separate: req.body?.separate === true,
    autoRotate: req.body?.autoRotate === true,
  };
  res.status(201).json(library.arrangeFile(req.params.id, bed, options));
});

filesRouter.post('/:id/orient', (req, res) => {
  const result = library.orientFile(req.params.id);
  res.status(result.changed ? 201 : 200).json(result);
});

/** Gom nhiều mô hình lên cùng một khay theo kích thước bàn của máy sẽ in. */
filesRouter.post('/combine', (req, res) => {
  const bed = slicer.machineBed({ machine: req.body?.machine, printerId: req.body?.printerId });
  const options = {
    gap: spacing(req.body?.gap, undefined),
    margin: spacing(req.body?.margin, undefined),
    autoRotate: req.body?.autoRotate === true,
    name: req.body?.name,
  };
  res.status(201).json(library.combineFiles(req.body?.items, bed, options));
});

/** Ghi lại vị trí mới của vật thể sau khi kéo thả trên khung xem 3D. */
filesRouter.post('/:id/layout', (req, res) => {
  res.json(library.moveObjects(req.params.id, req.body?.moves));
});

filesRouter.put('/:id', (req, res) => {
  res.json(library.renameFile(req.params.id, req.body?.name));
});

filesRouter.delete('/:id', (req, res) => {
  const result = library.deleteFile(req.params.id);
  slicechat.forgetFile(req.params.id);
  res.json(result);
});

/** Một bước: đưa file vào thư viện (upload, URL, nội dung, fileId có sẵn) rồi tạo job in. */
printRouter.post(
  '/',
  receiveUpload,
  wrap(async (req, res) => {
    const body = printOptions(req.body);
    if (typeof body.printerIds === 'string') body.printerIds = body.printerIds.split(',').filter(Boolean);
    if (!body.printerId && !body.printerIds) throw badRequest('error.field_required', { field: 'printerId' });
    const file = await ingest(req);
    const job = await jobs.createJob({ ...body, fileId: file.id, origin: requestOrigin(req) });
    res.status(201).json({ file, job });
  }),
);
