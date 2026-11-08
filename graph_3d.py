import numpy as np
import matplotlib.pyplot as plt
from matplotlib import cm

# Generate data
x = np.linspace(-5, 5, 100)
y = np.linspace(-5, 5, 100)
X, Y = np.meshgrid(x, y)
R = np.sqrt(X**2 + Y**2)
Z = np.sin(R) / R  # Sinc function for a smooth 3D wave

# Setup plot
fig = plt.figure(figsize=(12, 8), dpi=100)
ax = fig.add_subplot(111, projection='3d')

# Plot surface
surf = ax.plot_surface(X, Y, Z, cmap=cm.viridis, 
                       linewidth=0, antialiased=True, alpha=0.9)

# Aesthetics
ax.set_title("3D Mathematical Surface Visualization", fontsize=15)
ax.set_xlabel("X Axis")
ax.set_ylabel("Y Axis")
ax.set_zlabel("Z Axis")
fig.colorbar(surf, shrink=0.5, aspect=10)

# Adjust viewing angle for maximum "impressiveness"
ax.view_init(elev=30, azim=45)

# Save to file
plt.savefig('impressive_graph.png', bbox_inches='tight')
print("Graph saved as impressive_graph.png")
