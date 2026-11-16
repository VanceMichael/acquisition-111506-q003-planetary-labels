# 观测资料收件柜

这个服务保存观测的人工收件、历史版本和原始依据。重复提交相同业务内容与依据返回原收件；内容变化形成历史版本，原始字节用内容摘要回查。合作来源运行在本机，具体交互见 `docs/source-contract.md`。自动收件按 PDS4 标签选择测量对象并领取对应字节，不再要求先把整包转成 CSV。

## 运行环境

需要 Node.js 22.22.1 至 22.x，使用内置模块，没有第三方依赖。依赖锁文件随代码保存；`npm ci --offline --ignore-scripts --no-audit --no-fund` 不会下载包。数据目录默认是 `var`，可用 `DATA_DIR` 指定；不可让两个进程同时写同一目录。来源和收件服务默认只监听回环地址，不使用真实机构账号或外网数据。

## 开发与运行

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run demo
```

`npm start` 启动收件服务，默认端口4310；另一终端用 `npm run source` 启动来源端，默认端口4311。可分别通过 `PORT`、`SOURCE_PORT` 修改端口。测试和演示使用系统分配的端口，结束时关闭服务并删除临时收件数据，不需要固定等待时间。

## 已有收件接口

`GET /health` 查看状态；`POST /api/manual` 接收 `record` 和 `evidence`。业务内容需要 `observationId, product, measurements`，其中 `observationId` 是已有人工收件标识。每份依据包含来源 `source`、原始字节 `bytesBase64`，可选 `mediaType` 和需要核对的 `sha256`。`GET /api/records` 返回当前版本，`GET /api/history?key=...` 返回单个业务标识的历史，`GET /api/evidence/摘要` 返回原始字节。人工入口不推断自动采集是否完整；自动采集扩展保留这些已用接口。

## PDS4 自动收件接口

支持范围以 `docs/source-contract.md` 为准：`Product_Observational` 中 `File_Area_Observational` 的 `Table_Binary`，含 `Record_Binary`、`Field_Binary` 与嵌套 `Group_Field_Binary`；字段类型支持 `UnsignedMSB4`、`UnsignedLSB2`、`IEEE754LSBSingle`，未知类型的对象整体标记为不支持并保留可定位原因。

- `GET /api/source/objects?baseUrl=来源地址&labelPath=/products/17/label.xml`：只读取标签，盘点可选择的对象（标识、类型、记录数、是否支持、原因），不下载数据文件。
- `POST /api/ingest`：请求体 `{ baseUrl, labelPath?, objectIds?, window?, mode? }`。`objectIds` 用 `local_identifier` 或完整对象标识选择，省略表示盘点全部对象；`window` 为 `{start, count}`（记录从 0 开始，省略 count 读到末条）；`mode` 为 `full`（默认，领取全文并核对 file_size/MD5）或 `range`（只领取窗口字节，仅声明片段完整性）。
- 响应中每个对象独立给出 `status`：`published` 携带嵌套结构化记录（保留产品版本、对象标识、原始值、特殊常量种类、换算值与原文件绝对字节位置），其余为 `rejected` 并带原因码与说明；对象之间互不影响。
- 特殊常量先在原始值层面识别，命中则记录常量种类且不应用 `scaling_factor`/`value_offset`。数据 ETag 在一次收件内固定，版本变化（If-Match 412、大小或 MD5 不符）即拒绝，不沿用旧字节范围。
- `GET /api/ingests` 列出自动收件历史，`GET /api/ingests?ingestId=...` 查看单条；标签与数据原始字节随收件按 SHA-256 落盘，经 `GET /api/evidence/摘要` 回查。相同标签、对象选择、窗口、模式与依据重复提交返回原收件（`duplicate:true`）。

`fixtures/manual.json` 是可用的人工收件样例，`fixtures/product.xml` 与 `fixtures/measure.json` 是合作来源的 PDS4 标签和二进制数据样例。`npm run demo` 实际启动两个本地服务，展示人工提交、标签对象盘点、全文与记录窗口自动收件、特殊常量、被拒对象原因、原始依据回查和幂等重收；不访问外部网络。

## 容器

```sh
docker build -t planetary-labels-intake .
docker run --rm --network none planetary-labels-intake npm test
docker run --rm --network none planetary-labels-intake npm run demo
```

镜像内容由 Dockerfile 的 SHA256 摘要固定；Node.js 22 主版本标签与 package.json 的 >=22.22.1 <23 兼容范围对应，验证环境可使用该范围内的补丁版本。构建需要本地已有该基础镜像；正式运行、测试和演示不安装系统包、不下载模型或数据。服务默认数据放在容器内临时目录，持久运行时可挂载单独卷。演示完整输出可在90秒内展示，不播放预先保存的日志。
