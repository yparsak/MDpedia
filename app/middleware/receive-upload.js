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
