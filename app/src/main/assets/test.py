import numpy as np
import cv2
from ultralytics import YOLO
import os

img_path = "20260921_031734.jpg"
print(f"Файл существует: {os.path.exists(img_path)}")
print(f"Абсолютный путь: {os.path.abspath(img_path)}")


model = YOLO("braile.tflite")
results = model.predict(img_path, conf=0.01)

# Смотрим, какие данные реально шли на вход модели
# Ultralytics сам делает предобработку, но мы можем её воспроизвести:

img = cv2.imread(img_path)
img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)      # ← важно: BGR -> RGB
img = cv2.resize(img, (640, 640))
img = img.astype(np.float32) / 255.0
print("Python input shape:", img.shape)
print("Python input dtype:", img.dtype)
print("Python input min/max:", img.min(), img.max())
print("Python pixel [0,0]:", img[0, 0])  # первые 3 значения RGB