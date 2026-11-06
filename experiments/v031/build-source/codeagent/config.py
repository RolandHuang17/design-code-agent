import os


def user_variable(name: str, *, refresh: bool = False) -> str:
    """Keep CLI environment overrides; explicit GUI refresh rereads user settings."""
    value = os.environ.get(name)
    if value and not refresh:
        return value
    if os.name == "nt":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
                return str(winreg.QueryValueEx(key, name)[0])
        except OSError:
            pass
    return value or ""
