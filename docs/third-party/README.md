# 证书依赖

最终程序携带 certifi 2026.10.23 的 Mozilla CA 证书集合，用于 HTTPS 主机名和证书链校验。证书不是 API 密钥。使用固定证书包减少对干净 Windows 初始证书存储的依赖，没有关闭 TLS 校验。

来源：[certifi PyPI](https://pypi.org/project/certifi/2026.10.23/)、[上游源码](https://github.com/certifi/python-certifi)。许可声明原样保存于 [certifi-LICENSE.txt](certifi-LICENSE.txt)；该依赖不适用本工具原创源码的 MIT 许可。版本和证书文件 SHA256 记入最终构建清单。
