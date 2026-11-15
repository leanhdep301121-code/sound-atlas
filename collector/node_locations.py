"""Position mapping is versioned independently of each device's calibration."""
SWAP_EFFECTIVE_MS = 1794737635371
BASE_LOCATIONS = {
    "N3": ("A", "公桌 1"), "N2": ("B", "公桌 2"), "N1": ("C", "公桌 3"),
    "N5": ("D", "公桌 A"), "N4": ("E", "公桌 B"),
    "D1": ("D1", "个人工位"), "D2": ("D2", "宿舍 D2"),
}
FIRST_SWAP_LOCATIONS = {**BASE_LOCATIONS, "N4": ("D1", "个人工位"), "D1": ("E", "公桌 B")}

SECOND_SWAP_EFFECTIVE_MS = 1794740431054
LOCATION_VERSION = SECOND_SWAP_EFFECTIVE_MS
CURRENT_LOCATIONS = {**FIRST_SWAP_LOCATIONS, "D2": ("D1", "个人工位"), "N4": ("D2", "宿舍 N4")}

def location_at(node, stamp_ms):
    if stamp_ms >= SECOND_SWAP_EFFECTIVE_MS:
        return CURRENT_LOCATIONS[node]
    return (FIRST_SWAP_LOCATIONS if stamp_ms >= SWAP_EFFECTIVE_MS else BASE_LOCATIONS)[node]
