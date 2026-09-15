# Operator Guide — E-Car Traffic Light

[Historical operator illustration](operator_quick_guide.png) — its full-screen artwork is superseded by the symbol guide below.

Current field deployment is D1–D3. All symbols use a black background; software supports additional display IDs through D7.

## What the display means

| Display | Meaning | Operator action |
|---|---|---|
| Upward green arrow | Junction available | Proceed normally and remain aware of cross traffic |
| Filled upward yellow triangle | E-Car convoy is approaching / leaving protected zone, or the display has a fault / unknown command | Slow down and prepare to stop |
| Thick centered red X | E-Car traffic is still in the protected corridor, or exit clearance has not been confirmed | Stop and wait |
| Sensor fault reported in diagnostics (`ERR:S1`, etc.) | A sensor has a communication fault; explicit RED remains red, otherwise yellow triangle | Report/check the named sensor |
| `LINK ERR` reported in diagnostics | Display lost controller communication; explicit RED remains red, otherwise yellow triangle | Treat display as unreliable and report immediately |

## Important
- Healthy connected displays render the same Pi command. A local communication fault may change an individual display to yellow.
- The E-Car may tow dollies. Short empty spaces between cab, body, hitch, and dollies are normal and are remembered by the controller.
- RED remains active until the cycle has seen S1 occupied, then all S1-S4 sensors are online/fresh and continuously clear for the configured 1-second delay; corridor activity or a stopped vehicle holds RED. RETURN YELLOW then lasts 5 seconds. A new S4/S3 rising edge during RETURN immediately returns to RED.
- Fault text is available in maintenance diagnostics, not on the symbol panel. Unknown commands show yellow; green requires an explicit GREEN/GO command without an effective fault.

## Sensor names

```text
Travel direction ->
S4 ---- S3 ---------------- S2 ---- S1 ---- Junction
RED entry                   Corridor release confirmation
```

## If something looks wrong
1. Do not open the control box while energized unless authorized.
2. Note the display ID and symbol; ask maintenance to check diagnostics for `S1`, `S2`, `S3`, `S4`, or `LINK ERR`.
3. Inform maintenance/engineering.
4. If traffic behavior is visibly unsafe or inconsistent, stop using the junction and follow site safety procedure.


## สิ่งที่ผู้ขับจะเห็นบนจอ (Final)

- **สีเขียว:** ลูกศรชี้ขึ้นสีเขียวบนพื้นดำ
- **สีเหลือง:** รูปสามเหลี่ยมทึบชี้ขึ้นสีเหลืองบนพื้นดำ
- **สีแดง:** กากบาท X สีแดงเส้นหนาตรงกลางบนพื้นดำ
- จอที่ใช้งานจริงคือ D1–D3 จอที่เชื่อมต่อปกติแสดงตามคำสั่งจาก Pi
- เมื่อ Sensor มีปัญหาหรือขาดการติดต่อกับ Pi/MQTT จอคง X สีแดงหากคำสั่งเป็น RED/STOP มิฉะนั้นแสดงสามเหลี่ยมสีเหลือง
- คำสั่งที่ไม่รู้จักแสดงสามเหลี่ยมสีเหลือง รายละเอียด `ERR:S2` หรือ `LINK ERR` ให้ฝ่ายซ่อมบำรุงตรวจจากระบบวินิจฉัย ไม่มีข้อความบนจอสัญลักษณ์
