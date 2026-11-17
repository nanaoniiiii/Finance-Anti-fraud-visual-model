import io
import struct

import pytest

from poseguard.speech_agent import pcm_windows
from poseguard.speech_risk import (
    AUTHORITY_PRESSURE, CALL_INDICATOR, CODE_REQUEST, REMOTE_CONTROL,
    SAFE_ACCOUNT, cues,
)


def test_realistic_credential_request_and_disclosure_return_only_categories():
    assert cues("把短信验证码念给我。") == [CODE_REQUEST]
    assert cues("我的驗證碼是000000。") == [CODE_REQUEST]
    assert "000000" not in repr(cues("我的验证码是000000。"))


def test_customer_or_other_speaker_and_combined_transaction_cues():
    assert cues("先打开屏幕共享，再把钱转到安全账户。") == [REMOTE_CONTROL, SAFE_ACCOUNT]
    assert cues("银行客服说账户涉嫌洗钱，需要保密。") == [AUTHORITY_PRESSURE]
    assert cues("您拨打的用户正在通话中，请稍后再拨。") == [CALL_INDICATOR]


def test_safety_reminder_and_ordinary_operation_do_not_alarm():
    assert cues("不要把验证码告诉他人，别向陌生人转到安全账户。") == []
    assert cues("请勿将验证码告诉任何人。谢谢，请到正常柜台办理。") == []
    assert cues("正在银行官方APP输入验证码，忘了密码就走找回流程。") == []
    assert cues("打开屏幕共享上网课。") == []


def test_a_protective_sentence_does_not_cancel_a_different_request():
    text = "不要共享真实密码。但是，把短信验证码念给我。"
    assert cues(text) == [CODE_REQUEST]


def test_observed_whisper_credential_homophones_keep_safe_context():
    assert cues("請把短信驗證馬念給我。") == [CODE_REQUEST]
    assert cues("請誤將驗證馬告訴任何人。") == []
    assert cues("先打開屏幕共享，再把錢轉到安全帳戶。") == [REMOTE_CONTROL, SAFE_ACCOUNT]


def test_pcm_stream_decodes_little_endian_and_retains_last_complete_sample():
    full_window = struct.pack("<h", 16384) * (16000 * 3)
    windows = list(pcm_windows(io.BytesIO(full_window + struct.pack("<h", -32768)), 3))
    assert [len(samples) for samples, _ in windows] == [48000, 1]
    assert windows[0][0][0] == 0.5
    assert windows[1][0][0] == -1.0
    with pytest.raises(ValueError, match="middle of a sample"):
        list(pcm_windows(io.BytesIO(b"\x01"), 3))
