const REGION_RULES: Array<[string, RegExp]> = [
  ["jp", /日本|东京|大阪|jp|japan|tokyo|osaka/i],
  ["us", /美国|美國|洛杉矶|圣何塞|纽约|us|usa|america|los angeles|new york|san jose/i],
  ["sg", /新加坡|sg|singapore/i],
  ["hk", /香港|hk|hong\s*kong/i],
  ["tw", /台湾|台灣|tw|taiwan/i],
  ["kr", /韩国|韓国|kr|korea|seoul/i],
  ["de", /德国|德國|de|germany|frankfurt/i],
  ["gb", /英国|英國|uk|gb|london|britain/i],
  ["ca", /加拿大|ca|canada/i],
  ["au", /澳大利亚|澳洲|au|australia|sydney/i]
];

export function inferRegion(name: string): string {
  return REGION_RULES.find(([, pattern]) => pattern.test(name))?.[0] ?? "unknown";
}
