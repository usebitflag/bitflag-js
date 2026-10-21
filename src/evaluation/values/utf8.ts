/** The number of bytes `text` takes in UTF-8. A lone surrogate counts as the three bytes of U+FFFD. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

const encoder = new TextEncoder();

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** The number of Unicode code points in `text`. */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** Whether `text` has no unpaired surrogate, so that it has a UTF-8 form. */
export function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
      } else {
        return false;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
