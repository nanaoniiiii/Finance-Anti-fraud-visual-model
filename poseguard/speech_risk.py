"""Recognize phone-fraud cues from transient Mandarin speech transcripts."""

import re
import unicodedata


# The worker uses the same named codes, never the matched words or their values.
CODE_REQUEST = "speech_code_handoff"
SAFE_ACCOUNT = "speech_safe_account"
REMOTE_CONTROL = "speech_remote_control"
AUTHORITY_PRESSURE = "speech_authority_pressure"
CALL_INDICATOR = "speech_call_indicator"

_TRADITIONAL = str.maketrans("驗證碼發給聽轉賬銀賬戶屏幕遠程啟開電話撥機詐騙請別告訴號離辦匯報輸讓聯絡", "验证码发给听转账银账户屏幕远程启开电话拨机诈骗请别告诉号离办汇报输让联络")
_PROTECTIVE = re.compile(r"不要|不用|不必|请勿|严禁|千万别|不能|不会|不可以|不得|禁止|别把|拒绝|无人会")
_CLAUSES = re.compile(r"[。！？!?；;\n]+|(?:但是|不过|然而)")


def cues(transcript: str) -> list[str]:
    """Return evidence codes for actionable phrases, with protective context."""
    text = unicodedata.normalize("NFKC", transcript).translate(_TRADITIONAL).lower()
    text = text.translate(str.maketrans("帳錢唸馬將誤", "账钱念马将误"))
    text = text.replace("验证马", "验证码").replace("请误将", "请勿将").replace("请误把", "请勿把")
    result = set()
    for clause in _CLAUSES.split(text):
        clause = re.sub(r"[\s，,：:、“”\"'·]", "", clause)
        credential = re.search(r"验证码|校验码|短信代码|动态口令|支付密码|银行卡密码|取款密码|密码", clause)
        if credential and not _PROTECTIVE.search(clause):
            action = re.search(
                r"念给|读给|报给|发给|告诉|提供|转发|截图发|说给|口头报|汇报|"
                r"(?:验证码|密码).{0,6}(?:是|为)?[:：]?[0-9一二两三四五六七八九零〇幺]{4,10}|"
                r"(?:念|说|报|读)(?:一下|出|一遍).{0,18}(?:验证码|密码)|"
                r"(?:输入|填写|提交).{0,16}(?:验证码|密码).{0,15}(?:链接|网页|对话框)",
                clause,
            )
            safe_destination = re.search(r"(?:官方|银行)(?:app|客户端|网站|柜员机)", clause)
            if action and not safe_destination:
                result.add(CODE_REQUEST)
        if not _PROTECTIVE.search(clause):
            if re.search(r"安全(?:账|帐)户|监管账户|资金核查账户", clause) and re.search(
                r"转到|转入|转给|汇入|汇到|打到|转账|汇款|核验|资金", clause
            ):
                result.add(SAFE_ACCOUNT)
            if re.search(r"屏幕共享|共享屏幕|远程控制|远程协助", clause) and re.search(
                r"打开|开启|点击|下载|安装|屏幕共享|共享屏幕|同意|给我|我来操作",
                clause,
            ) and not re.search(r"上课|网课|开会|演示文稿|课件|投屏给同事", clause):
                result.add(REMOTE_CONTROL)
            if re.search(r"公安|检察院|法院|银监|反诈中心|银行客服", clause) and re.search(
                r"涉嫌|洗钱|拘留|冻结.{0,8}(?:账户|银行卡)|保密|立刻.{0,8}转账",
                clause,
            ):
                result.add(AUTHORITY_PRESSURE)
        if re.search(r"您拨打的|正在通话|通话中|暂时无法接通|请稍后再拨|呼叫转移|语音信箱", clause):
            result.add(CALL_INDICATOR)
    return sorted(result)
