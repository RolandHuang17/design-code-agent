import os


def user_variable(name: str) -> str:
    """Read Windows user settings even when the desktop process predates the change."""
    value = os.environ.get(name)
    if value:
        return value
    if os.name == "nt":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
                return str(winreg.QueryValueEx(key, name)[0])
        except OSError:
            pass
    return ""
