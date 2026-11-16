# 观测资料收件柜：合作来源契约

入口为`/products/17/label.xml`，文件地址相对标签解析。来源使用PDS4 Product_Observational与File_Area_Observational中的Table_Binary。支持Record_Binary、Field_Binary和嵌套Group_Field_Binary；不要求覆盖全部PDS产品类。字段类型至少支持UnsignedMSB4、UnsignedLSB2、IEEE754LSBSingle，未知类型留下对象不支持原因。标识由logical_identifier、version_id、local_identifier和记录/重复组位置共同构成，不使用名称替代身份。

offset是文件内从零开始的字节偏移；record_length规定记录跨度。field_location、group_location按PDS约定从1开始，嵌套位置相对所属记录或组。group_length覆盖该组的全部重复，总跨度与repetitions共同描述布局。字段先根据原始值识别Special_Constants，再对正常值使用scaling_factor与value_offset。结构化内容保留原始值、特殊常量种类和实际字节位置，不强求扁平列结构。

来源支持HTTP Range、ETag、If-Match，返回206及Content-Range；`startProvider({scenario:'changed'})`在第二次文件请求后换成更大版本。标签有文件大小与MD5声明，正式收件的校验依据需要明确；若采用局部读取，不能声称已验证未读全文的摘要。默认文件有独立不支持的注释对象，不应将其伪装成空的测量记录。测试夹具的XML只使用无外部实体的标准命名空间文档，解析器也不需要解析外部DTD。自动收件可以提供对象选择和记录窗口，不要求按固定列号识别内容。

## 收件端实现约定

- 标签解析只接受标准命名空间的 Product_Observational；内置最小 XML 解析器拒绝 DTD、外部实体与未声明实体，不加载任何外部资源。
- 对象身份由 `logical_identifier::version_id` 加 `local_identifier`，再加上记录下标与重复组路径共同构成，名称只用于展示不用于身份。
- 一次收件的多个对象相互隔离：不支持或损坏的对象只在自身结果中给出可定位原因（对象标识、原因码与说明），同一产品中独立可收的对象照常发布，结果中不出现伪装成空测量的占位记录。
- 数据字节在一次收件内绑定首个数据 ETag，后续区间请求带 If-Match；收到 412 或 Content-Range/大小与标签声明不符时拒绝该对象，绝不沿用上一版本的字节范围。
- 完整性分两级：全文领取（默认）核对标签 `file_size` 与 MD5，通过才标记 `full`/`md5Verified:true`；记录窗口的局部领取只做 Content-Range 与长度核对，标记 `partial` 且明确 `md5Verified:false`。
- 结构化结果保留产品版本、对象标识、字段原始值、特殊常量种类、换算结果以及字段在原文件中的绝对字节位置；嵌套重复组以父子层级输出，不打平成固定列。
- 标签全文与实际领取的数据字节都作为原始依据，按 SHA-256 内容寻址落盘并可回查；只有能证明标签与数据相符的对象才进入 `published`。

## 来源与支持范围

格式参考：`https://pds.nasa.gov/datastandards/documents/`。这里运行的是只含虚构资料的本地合作端，不是公网生产服务；只需支持本文明确给出的范围。来源实现和样例可以阅读，自动接入应使用声明的交互入口，不把服务内部对象或预先写好的采集结论当作数据来源。原始依据、结构化内容和完整性状态应能在收件端回查；新增自动接口的名称与内部设计由开发者决定。
