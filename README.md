# Coursive 课程伴学

从 Coursive 的插件来源中选择“从文件夹安装”，选中包含本文件和 `package.json` 的目录。首次本地安装按界面提示确认来源与“读取资料库”权限。打开课程的小 C 对话，在输入框的“+”中选“课程伴学”，或直接说“带我复习这门课中的线程同步，我只有二十分钟”。

插件根据复习目标从本课程读取已解析课件和录像转写，给每个单元存一份可回看的依据。小 C 讲解后可以出选择题或简答题。选择题单独回复字母（如 B）；简答以“作答：”开头，插件保留原回答，小 C 按出题时的判据逐条反馈并摘引你的原话。你可以先追问，也可发“暂停”“继续”或“跳过”。答错时重新讲解并换题；单元结束后做迁移题。使用小 C 当前的模型和网络设置。

同一设备、同一条小 C 对话可在重启后续学。另开对话可制定新计划。进度保存在插件私有数据目录，当前未接入跨设备同步或画布专用的圈选运行器。模型负责组织讲解、编题及拟定答案，选择题评分遵循该题的答案；答题结果只代表本次练习。

## 设计来源

使用 REA 6.8.0 静态检查 Kaopy 教学扩展 1.2.12 的 VSIX，包 SHA-256 为 `f994ae956476a3cb8947308cb7a7562247b3bee2128879992c2a39131da8ce30`。参考其随包提供的 `extension/harness/server.py` 中的阶段退出校验（901 行）、阶段配置（教学部分从 1847 行开始）和练习块处理。Coursive 版本独立实现工具、状态机和中文教学指引，使用本地课程接口、Pi 会话与 Coursive 来源链接。

运行 `node --test test/*.test.mjs` 可检查教学状态和故障分支。在 Coursive 主仓库可用 `node agent/scripts/validate-plugin.mjs /path/to/course-tutor --files` 校验清单，或用 `node agent/scripts/plugin-sim.mjs /path/to/course-tutor --pack /path/to/output` 在临时宿主安装并打包。

## 安装与数据使用

在插件来源中可选择 Git，输入固定版本 `https://github.com/kniphofia1/coursive-course-tutor.git#v0.1.0`。如果设备没有 Git，可以解压 Release 中的安装包，再选择含有 `package.json` 的文件夹。也可以添加本仓库的 [插件目录](https://raw.githubusercontent.com/kniphofia1/coursive-course-tutor/v0.1.0/coursive-catalog.json)。

插件只申请 `library.read`，用于读取指定课程的节次、已解析课件和录像转写。学习记录存于 Coursive 插件私有目录；插件不自设网络服务、不读取模型密钥、不使用遥测。使用在线小 C 模型时，取出的摘录和作答会作为对话上下文发送给用户配置的模型服务。
