"""停车预测离线管道（阶段 1：Schema + 合成生成器 + 读取层骨架）。"""

__version__ = "1.0.0"

from .schema import validate

__all__ = [
    "__version__",
    "validate",
    "SynthConfig",
    "generate",
    "ar1_noise",
    "demo_config",
    "GENERATOR_VERSION",
    "Dataset",
    "DatasetConfig",
    "load_observations",
    "QUALITY_RANK",
]


def __getattr__(name):
    # 懒加载，避免 `python -m pf.synth` 时 __init__ 提前 import synth 触发 runpy 警告。
    if name in {"SynthConfig", "generate", "ar1_noise", "demo_config", "GENERATOR_VERSION"}:
        from . import synth
        return getattr(synth, name)
    if name in {"Dataset", "DatasetConfig", "load_observations", "QUALITY_RANK"}:
        from . import dataset
        return getattr(dataset, name)
    raise AttributeError("module %r has no attribute %r" % (__name__, name))
