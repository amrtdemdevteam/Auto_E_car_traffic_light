from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from gpiozero import LED
from pydantic import BaseModel, conint, confloat
from threading import Thread
from time import sleep
from contextlib import asynccontextmanager
import uvicorn

# FastAPI lifespan (no global LED needed anymore)
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Starting FastAPI app...")
    try:
        yield
    finally:
        print("Shutting down... cleanup done.")

app = FastAPI(lifespan=lifespan)

# Request model with validation
class LEDTriggerRequest(BaseModel):
    pin: conint(ge=0, le=27)  # GPIO pins (0–27)
    duration: confloat(gt=0.0, le=10.0)  # Duration in seconds (max 10s)

# Background thread function
def trigger_led(pin: int, duration: float):
    try:
        led = LED(pin)
        led.off()
        print("Led: {} On!".format(pin))
        sleep(duration)
        
        led.on()
        print("Led: {} Off!".format(pin))
        led.close()
    except Exception as e:
        print(f"Error triggering LED on GPIO{pin}: {e}")

@app.get("/")
def read_root():
    return {"message": "LED Control API with dynamic pin and duration"}

@app.post("/led/trigger")
def trigger_led_endpoint(data: LEDTriggerRequest):
    # Start LED trigger in a background thread
    Thread(target=trigger_led, args=(data.pin, data.duration)).start()
    return JSONResponse(content={"status": f"Triggered LED on GPIO{data.pin} for {data.duration:.2f} seconds"})

# Run the FastAPI app
if __name__ == "__main__":
    uvicorn.run("fastapi_gpio_server:app", host="0.0.0.0", port=8000, reload=False)
