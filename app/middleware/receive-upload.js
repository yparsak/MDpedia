import multer from 'multer';

// Multipart parsing for the admin forms that take one file. It runs after the
// admin check and before the CSRF check, because the token is a form field. The
// file stays in memory (the caps are small). A refused upload is not an error
// response: req.uploadError is set and the route shows its own message.
export function receiveUpload({ maxBytes, fields = 5 }) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields, fieldSize: 10 * 1024, parts: fields + 5 },
    defParamCharset: 'utf8',
  }).single('file');
  return (req, res, next) =>
    upload(req, res, (err) => {
      req.uploadError = err ?? null;
      next();
    });
}

// The same for the bulk import: many files in one field named "files". A file over
// the upload cap must be skipped and reported without failing the batch, so the
// transport limit per file is a few times the cap; the service applies the real cap.
// A file over the transport limit, or too many files, is an upload error.
export function receiveUploads({ maxBytes, maxFiles, fields = 3 }) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes * 4, files: maxFiles, fields, fieldSize: 10 * 1024, parts: maxFiles + fields + 5 },
    defParamCharset: 'utf8',
  }).array('files', maxFiles);
  return (req, res, next) =>
    upload(req, res, (err) => {
      req.uploadError = err ?? null;
      next();
    });
}
