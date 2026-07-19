/** 文案包由 wrangler 的 Text 规则以字符串形式打进包体 */
declare module "*.pack" {
  const content: string;
  export default content;
}
