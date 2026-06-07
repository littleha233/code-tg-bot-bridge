export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 11)}\n\n[内容已截断]`;
}

export function splitMessageByLength(value: string, maxLength = 3500): string[] {
  if (value.length <= maxLength) {
    return [value];
  }

  const lines = value.split("\n");
  const chunks: string[] = [];
  let buffer = "";

  for (const line of lines) {
    const candidate = buffer ? `${buffer}\n${line}` : line;
    if (candidate.length <= maxLength) {
      buffer = candidate;
      continue;
    }

    if (buffer) {
      chunks.push(buffer);
    }

    if (line.length <= maxLength) {
      buffer = line;
      continue;
    }

    for (let index = 0; index < line.length; index += maxLength) {
      chunks.push(line.slice(index, index + maxLength));
    }
    buffer = "";
  }

  if (buffer) {
    chunks.push(buffer);
  }

  return chunks;
}
