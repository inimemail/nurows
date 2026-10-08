import { PNG } from 'image-size/types/png';
import { JPG } from 'image-size/types/jpg';
import { WEBP } from 'image-size/types/webp';

export function authenticatorImageDimensions(bytes, mime) {
  const parser = { 'image/png': PNG, 'image/jpeg': JPG, 'image/webp': WEBP }[mime];
  let result;
  try {
    if (!parser || !parser.validate(bytes)) throw Error();
    result = parser.calculate(bytes);
  } catch { throw Error('图片格式无效，请选择 PNG、JPEG 或 WebP 图片'); }
  const { width, height } = result;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16000000) throw Error('图片尺寸过大');
  return { width, height };
}
